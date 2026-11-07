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
      g.input.hold('forward', true);
      g.advance(3);
      g.input.hold('forward', false);
      return Math.abs(g.ctx.player.vehicle?.kmh || 0);
    });
    console.log(`  speed after 3 s (simulated) of throttle: ${kmh.toFixed(0)} km/h`);
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
    if (!b.units) throw new Error('no police units spawned');
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
    await page.evaluate(() => window.__game.ctx.wanted.clear());
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
  await step('start story mission', async () => {
    await page.evaluate(() => {
      const { ctx } = window.__game;
      if (ctx.player.vehicle) ctx.player.exitVehicle(true);
      const m = ctx.missions.giverMarkers[0];
      ctx.player.teleport(m.x, m.z);
    });
    await page.evaluate(() => window.__game.advance(1));
    const active = await page.evaluate(() => window.__game.ctx.missions.active?.def.title || null);
    console.log(`  active mission: ${active}`);
    if (!active) throw new Error('mission did not start');
  });
  await shot('06-mission');
  await step('complete story mission 1', async () => {
    // wait for the van to spawn after the dialogue
    await page.evaluate(() => window.__game.advance(9));
    await page.waitForFunction(() => !!window.__game.ctx.missions.active?.refs.van, { timeout: 30000 });
    await page.evaluate(() => {
      const { ctx } = window.__game;
      const van = ctx.missions.active.refs.van;
      const p = van.body.translation();
      ctx.player.teleport(p.x + 2.6, p.z);
      ctx.player.enterVehicle(van);
    });
    await page.evaluate(() => window.__game.advance(0.5));
    await page.waitForFunction(() => window.__game.ctx.missions.step?.type === 'deliver', { timeout: 30000 });
    await page.evaluate(() => window.__game.advance(0.5));
    await page.evaluate(() => {
      const { ctx } = window.__game;
      const at = ctx.missions.step.state.at;
      const van = ctx.player.vehicle;
      van.body.setTranslation({ x: at.x, y: 1.2, z: at.z }, true);
      van.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    });
    await page.evaluate(() => window.__game.advance(4));
    await page.waitForFunction(() => window.__game.ctx.missions.progress.story === 1, { timeout: 30000 });
    await shot('06b-mission-passed');
    const money = await page.evaluate(() => window.__game.ctx.player.money);
    console.log(`  money after mission: €${money}`);
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
  errors.push(`test: ${e.message}`);
  await shot('error').catch(() => {});
}
await browser.close();
server.close();
if (errors.length) {
  console.error(`\n${errors.length} error(s):\n${[...new Set(errors)].join('\n')}`);
  process.exit(1);
}
console.log('\nSmoke test passed.');
