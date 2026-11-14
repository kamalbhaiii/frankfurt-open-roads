/**
 * Browser smoke test: loads dist/index.html in headless Chrome, starts a new game,
 * drives around, opens menus and fails on any page error.
 *
 *   node tests/smoke.mjs [--shots]     (set CHROME_PATH if Chrome isn't auto-detected)
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { serve } from '../tools/serve.mjs';

const shots = process.argv.includes('--shots');
const dirArg = process.argv.indexOf('--dir');
const distDir = dirArg >= 0 ? process.argv[dirArg + 1] : 'dist';
const { server, url } = await serve(distDir, 18080 + Math.floor(Math.random() * 500));
const outDir = process.env.SHOT_DIR || 'tests/screenshots';
const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Edge found. Set CHROME_PATH.');
  process.exit(2);
}

const errors = [];
const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
// software rendering is slow: test on the Low preset (also what phones get)
await page.evaluateOnNewDocument(() => localStorage.setItem('fs.settings.v1', JSON.stringify({ quality: 'low' })));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource|fonts\.g|net::ERR|brightsky|open-meteo/i.test(m.text())) errors.push(`console: ${m.text()}`);
});
const shot = async (name) => {
  if (!shots) return;
  fs.mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
};
const step = async (label, fn) => {
  const t = Date.now();
  await fn();
  console.log(`✓ ${label} (${Date.now() - t} ms)`);
};

try {
  await step('load + build world', async () => {
    await page.goto(url);
    await page.waitForFunction(() => window.__game && window.__game.ctx.game.state === 'title', { timeout: 240000 });
  });
  await shot('01-title');
  await step('new game', async () => {
    await page.click('[data-a="new"]');
    await page.waitForFunction(() => window.__game.ctx.game.state === 'playing', { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));
  });
  await shot('02-on-foot');
  await step('enter vehicle and drive', async () => {
    const entered = await page.evaluate(() => {
      const { ctx } = window.__game;
      // the coupé parked in front of the spawn has a clear road ahead
      const car = ctx.vehicles.list.find((c) => c.kind === 'coupe' && c.mode === 'parked');
      const p = car.body.translation();
      ctx.player.teleport(p.x + 2.5, p.z);
      return ctx.player.enterVehicle(car);
    });
    if (!entered) throw new Error('could not enter a vehicle');
    // software rendering is slow, so step the game logic directly (advance() skips rendering)
    const kmh = await page.evaluate(() => {
      const g = window.__game;
      // peak speed: the road ahead of the spawn isn't guaranteed to stay clear for 3 s
      g.input.hold('forward', true);
      let peak = 0;
      for (let i = 0; i < 12; i++) {
        g.advance(0.25);
        peak = Math.max(peak, Math.abs(g.ctx.player.vehicle?.kmh || 0));
      }
      g.input.hold('forward', false);
      return peak;
    });
    console.log(`  peak speed within 3 s (simulated) of throttle: ${kmh.toFixed(0)} km/h`);
    if (kmh < 10) throw new Error('vehicle did not accelerate');
  });
  await shot('03-driving');
  await step('heat + police pursuit', async () => {
    const nearest = () =>
      page.evaluate(() => {
        const { ctx } = window.__game;
        const p = ctx.player.position;
        const d = ctx.police.units.map((u) => Math.hypot(u.car.position.x - p.x, u.car.position.z - p.z));
        return { units: d.length, nearest: d.length ? Math.min(...d) : null };
      });
    const waitSim = (s) => page.evaluate((d) => window.__game.advance(d), s);
    await page.evaluate(() => window.__game.ctx.wanted.setMinLevel(2));
    await waitSim(5);
    const a = await nearest();
    await waitSim(12);
    const b = await nearest();
    console.log(`  units ${a.units} → ${b.units}, nearest ${a.nearest?.toFixed(0)} m → ${b.nearest?.toFixed(0)} m`);
    // units may already have gone home if the heat was lost (correct behaviour)
    if (!a.units && !b.units) throw new Error('no police units spawned');
  });
  await shot('04-police');
  await step('waypoint + GPS route', async () => {
    const ok = await page.evaluate(() => {
      const { ctx } = window.__game;
      const p = ctx.player.position;
      ctx.map.setWaypoint(p.x + 600, p.z + 300);
      ctx.gps.update(0.1);
      return !!ctx.gps.route && ctx.gps.route.points.length > 2;
    });
    if (!ok) throw new Error('no GPS route');
  });
  await step('pause menu tabs', async () => {
    // the chase may have ended in an arrest: let that sequence finish first
    await page.evaluate(() => {
      window.__game.ctx.wanted.clear();
      window.__game.ctx.police.reset();
    });
    await page.waitForFunction(() => window.__game.ctx.game.state === 'playing', { timeout: 60000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__game.ctx.game.state === 'paused', { timeout: 30000 });
    for (const t of ['map', 'brief', 'stats', 'settings', 'controls', 'game']) {
      await page.click(`[data-tab="${t}"]`);
      await new Promise((r) => setTimeout(r, 250));
      await shot(`05-pause-${t}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__game.ctx.game.state === 'playing', { timeout: 30000 });
  });
  await step('phone + Uber ride', async () => {
    const res = await page.evaluate(() => {
      const g = window.__game, c = g.ctx;
      if (c.player.vehicle) c.player.exitVehicle(true);
      // get into a normal car near the spawn
      // a fresh car: the coupé from earlier steps may have been rammed by the police
      const p0 = c.player.position;
      const spot = c.roads.nearest(p0.x, p0.z, 200);
      const car = c.vehicles.spawn('sedan', spot.x, spot.z, 0, 'parked', { driver: false });
      g.advance(0.5);
      const q = car.body.translation();
      c.player.teleport(q.x + 2.6, q.z);
      c.player.enterVehicle(car);
      g.advance(1);
      c.phone.toggle();
      c.phone.go('uber');
      c.phone.data.uber.online = true;
      c.phone.reqTimer = 0;
      g.advance(0.5);
      const hadRequest = !!c.phone.request;
      c.phone.acceptRequest();
      const job = c.missions.active?.def.id;
      // drive the passenger by teleporting the car onto each target
      for (let i = 0; i < 6 && c.missions.active; i++) {
        const s = c.missions.step;
        if (s?.type === 'goto' && s.state.at) {
          const v = c.player.vehicle;
          v.body.setTranslation({ x: s.state.at.x, y: 1.2, z: s.state.at.z }, true);
          v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        }
        g.advance(1.5);
      }
      return { hadRequest, job, done: c.phone.data.uber.rides, money: c.player.money, open: c.phone.open };
    });
    console.log(`  Uber: request ${res.hadRequest}, job ${res.job}, rides ${res.done}, money €${res.money}`);
    if (!res.hadRequest || res.job !== 'uber' || res.done < 1) throw new Error('Uber ride did not complete');
  });
  await step('phone apps render', async () => {
    for (const app of ['home', 'instagram', 'whatsapp', 'maps', 'bank', 'settings', 'uber']) {
      await page.evaluate((a) => {
        const c = window.__game.ctx;
        if (!c.phone.open) c.phone.toggle();
        c.phone.go(a);
      }, app);
      await shot(`06-phone-${app}`);
    }
    await page.evaluate(() => window.__game.ctx.phone.setOpen(false));
  });
  await step('bus job from depot', async () => {
    const res = await page.evaluate(() => {
      const g = window.__game, c = g.ctx;
      if (c.player.vehicle) c.player.exitVehicle(true);
      const d = c.depots.nearest('bus');
      const bus = d.car;
      const q = bus.body.translation();
      c.player.teleport(q.x + 3, q.z);
      c.player.enterVehicle(bus);
      g.advance(1);
      c.missions.toggleJob();
      const job = c.missions.active?.def.id;
      const money0 = c.player.money;
      for (let i = 0; i < 8; i++) {
        const s = c.missions.step;
        if (s?.type === 'goto' && s.state.at) {
          const v = c.player.vehicle;
          v.body.setTranslation({ x: s.state.at.x, y: 1.6, z: s.state.at.z }, true);
          v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        }
        g.advance(2.5);
      }
      const paid = c.player.money - money0;
      // stop the shift (it may already have ended if the teleported bus hit a parked car)
      if (c.missions.active?.def.id === 'bus') c.missions.toggleJob();
      return { job, paid, active: !!c.missions.active };
    });
    console.log(`  bus job: ${res.job}, earned €${res.paid}, still active: ${res.active}`);
    if (res.job !== 'bus' || res.paid <= 0 || res.active) throw new Error('bus job failed');
  });
  await step('save + reload data', async () => {
    const ok = await page.evaluate(() => {
      const { ctx } = window.__game;
      ctx.missions.abort('test');
      const data = ctx.game.serialize();
      return ctx.game.load(JSON.parse(JSON.stringify(data)));
    });
    if (!ok) throw new Error('save/load round trip failed');
  });
  await step('death sequence', async () => {
    await page.evaluate(() => window.__game.ctx.player.damage(500, 'test'));
    await page.waitForFunction(() => window.__game.ctx.game.state === 'wasted', { timeout: 30000 });
    await shot('07-wasted');
    await page.waitForFunction(() => window.__game.ctx.game.state === 'playing', { timeout: 15000 });
  });
  const fps = await page.evaluate(() => window.__game.ctx.fps);
  console.log(`fps (software rendering): ${fps?.toFixed(1)}`);
} catch (e) {
  errors.push(`test: ${e.message}${e.cause ? ` (cause: ${e.cause.message || e.cause})` : ''}`);
  await shot('error').catch(() => {});
}
await browser.close();
server.close();
if (errors.length) {
  console.error(`\n${errors.length} error(s):\n${[...new Set(errors)].join('\n')}`);
  process.exit(1);
}
console.log('\nSmoke test passed.');
