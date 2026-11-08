/**
 * Frame-time profiler on the real GPU: drives through the city with an autopilot,
 * starts a police chase, and reports frame-time percentiles plus the long frames
 * with the systems that caused them.
 *
 *   node tests/perf.mjs [--dir dist] [--quality high] [--seconds 60]
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { serve } from '../tools/serve.mjs';

const a = process.argv.slice(2);
const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const dir = opt('--dir', 'dist');
const quality = opt('--quality', 'high');
const seconds = Number(opt('--seconds', 60));
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));

const { server, url } = await serve(dir, 19700);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || chrome,
  headless: 'new',
  protocolTimeout: 900000,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--window-size=1600,900', '--disable-frame-rate-limit'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
await page.evaluateOnNewDocument((q) => localStorage.setItem('fs.settings.v1', JSON.stringify({ quality: q, weatherMode: 'clear' })), quality);
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__game?.ctx.game.state === 'title', { timeout: 600000 });
await page.click('[data-a="new"]');
await page.waitForFunction(() => window.__game.ctx.game.state === 'playing', { timeout: 120000 });

const gpu = await page.evaluate(() => {
  const gl = window.__game.ctx.renderer.getContext();
  const e = gl.getExtension('WEBGL_debug_renderer_info');
  return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
});

await page.evaluate((secs) => {
  const g = window.__game, c = g.ctx;
  // ---- instrument systems
  const cur = { sys: {}, events: [] };
  const wrap = (obj, name, label) => {
    const f = obj[name];
    obj[name] = function (...args) {
      const t = performance.now();
      const r = f.apply(this, args);
      cur.sys[label] = (cur.sys[label] || 0) + performance.now() - t;
      return r;
    };
  };
  wrap(c.game, 'simulate', 'simulate(physics+traffic)');
  wrap(c.traffic, 'update', 'sim:traffic');
  wrap(c.vehicles, 'step', 'sim:vehicles.step');
  wrap(c.physics, 'step', 'sim:physics.step');
  wrap(c.player, 'step', 'sim:player');
  wrap(c.peds, 'update', 'peds');
  wrap(c.police, 'update', 'police');
  wrap(c.furniture, 'update', 'furniture');
  wrap(c.missions, 'update', 'missions');
  wrap(c.gps, 'update', 'gps');
  wrap(c.vehicles, 'sync', 'vehicles.sync');
  wrap(c.hud, 'update', 'hud+minimap');
  wrap(c.env, 'update', 'environment');
  wrap(c.pipeline, 'render', 'render');
  wrap(c.phone, 'update', 'phone');
  wrap(c.depots, 'update', 'depots');
  wrap(c.audio, 'update', 'audio');
  const spawn = c.vehicles.spawn.bind(c.vehicles);
  c.vehicles.spawn = (...args) => {
    const t = performance.now();
    const v = spawn(...args);
    cur.events.push(`spawn ${args[0]} ${(performance.now() - t).toFixed(1)}ms`);
    return v;
  };
  // ---- autopilot: follow the GPS route to far waypoints
  const car = c.vehicles.list.find((v) => v.kind === 'coupe');
  const q = car.body.translation();
  c.player.teleport(q.x + 2.6, q.z);
  c.player.enterVehicle(car);
  const pickTarget = () => {
    const p = c.player.position;
    const ang = Math.random() * Math.PI * 2;
    c.map.setWaypoint(p.x + Math.cos(ang) * 1500, p.z + Math.sin(ang) * 1500);
  };
  pickTarget();
  window.__perf = { frames: [], start: performance.now(), secs };
  let last = performance.now(), progs = 0, tex = 0, geo = 0, wanted = false;
  const tick = () => {
    const now = performance.now();
    const info = c.renderer.info;
    const f = { dt: now - last, sys: cur.sys, events: cur.events, programs: info.programs?.length || 0, textures: info.memory.textures, geometries: info.memory.geometries };
    if (f.programs > progs && progs) for (const pr of info.programs.slice(progs)) { const twin = info.programs.slice(0, progs).find((o) => o.name === pr.name && o.cacheKey.split(",").slice(0, 3).join() === pr.cacheKey.split(",").slice(0, 3).join()); const A = pr.cacheKey.split(","), B = twin ? twin.cacheKey.split(",") : []; f.events.push(`+shader ${pr.name}: diff ${A.map((x, i) => (x !== B[i] ? i + "=" + B[i] + "->" + x : "")).filter(Boolean).join(" ")}`); }
    if (f.textures > tex + 2 && tex) f.events.push(`+${f.textures - tex} textures`);
    if (f.geometries > geo + 20 && geo) f.events.push(`+${f.geometries - geo} geometries`);
    progs = f.programs;
    tex = f.textures;
    geo = f.geometries;
    if (c.pipeline.stats) f.scale = c.pipeline.stats.scale ?? c.pipeline.scale;
    window.__perf.frames.push(f);
    cur.sys = {};
    cur.events = [];
    last = now;
    // steering
    const v = c.player.vehicle;
    const pts = c.gps.route?.points;
    if (v && pts && pts.length > 2) {
      const p = v.body.translation();
      let tgt = pts[Math.min(pts.length - 1, 3)];
      for (const pt of pts) if (Math.hypot(pt[0] - p.x, pt[1] - p.z) > 14) { tgt = pt; break; }
      const want = Math.atan2(tgt[0] - p.x, tgt[1] - p.z);
      let err = want - v.yaw;
      err = Math.atan2(Math.sin(err), Math.cos(err));
      const kmh = Math.abs(v.kmh || 0);
      g.input.touchMove = { x: Math.max(-1, Math.min(1, -err * 2)), y: kmh > 55 || Math.abs(err) > 0.6 ? 0.2 : -1, active: true };
      if (c.gps.distance < 40) pickTarget();
    } else if (!c.gps.route) pickTarget();
    if (!wanted && now - window.__perf.start > 20000) {
      wanted = true;
      c.wanted.setMinLevel(2);
    }
    if (now - window.__perf.start < secs * 1000) requestAnimationFrame(tick);
    else window.__perf.done = true;
  };
  requestAnimationFrame(tick);
}, seconds);

await page.waitForFunction(() => window.__perf?.done, { timeout: (seconds + 120) * 1000, polling: 1000 });
const r = await page.evaluate(() => {
  const all = window.__perf.frames;
  const fr = all.length > 60 ? all.slice(30) : all; // skip warm-up
  if (!fr.length) return { frames: 0 };
  const dts = fr.map((f) => f.dt).sort((x, y) => x - y);
  const pct = (p) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))];
  const avgSys = {};
  for (const f of fr) for (const k in f.sys) avgSys[k] = (avgSys[k] || 0) + f.sys[k] / fr.length;
  const long = fr
    .filter((f) => f.dt > 33)
    .sort((x, y) => y.dt - x.dt)
    .slice(0, 15)
    .map((f) => ({ dt: +f.dt.toFixed(1), top: Object.entries(f.sys).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(1)}`), events: f.events, scale: f.scale }));
  const scales = [...new Set(fr.map((f) => f.scale).filter((s) => s != null).map((s) => Number(s).toFixed(2)))];
  return {
    frames: fr.length,
    fps: (1000 / (dts.reduce((s, x) => s + x, 0) / dts.length)).toFixed(1),
    p50: pct(0.5).toFixed(1), p95: pct(0.95).toFixed(1), p99: pct(0.99).toFixed(1), max: dts[dts.length - 1].toFixed(1),
    over33: fr.filter((f) => f.dt > 33).length, over50: fr.filter((f) => f.dt > 50).length, over100: fr.filter((f) => f.dt > 100).length,
    avgSys: Object.fromEntries(Object.entries(avgSys).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, +v.toFixed(2)])),
    scales,
    long,
    vehicles: window.__game.ctx.vehicles.list.length,
    peds: window.__game.ctx.peds.list.length,
  };
});
console.log(JSON.stringify({ gpu, quality, ...r }, null, 1));
await browser.close();
server.close();
