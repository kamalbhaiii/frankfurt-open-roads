/**
 * Loading screen: an illustrated skyline (drawn from the real tower heights) that
 * cycles through dusk, night and day, with real load progress and gameplay tips.
 */
import { createRng } from '../core/math.js';

/** [x position (m, west→east), height (m)] of Frankfurt's towers from the OSM data. */
const TOWERS = [
  [-1519, 257],
  [-1458, 185],
  [-1396, 172],
  [-1363, 128],
  [-1293, 200],
  [-1006, 142],
  [-823, 198],
  [-686, 109],
  [-672, 142],
  [-522, 170],
  [-436, 155],
  [-393, 155],
  [-385, 155],
  [-347, 166],
  [-326, 154],
  [-287, 170],
  [-246, 115],
  [-220, 136],
  [-167, 89],
  [-149, 110],
  [-128, 200],
  [-113, 115],
  [-96, 82],
  [-83, 132],
  [-52, 183],
  [-36, 178],
  [-25, 132],
  [-15, 79],
  [2, 66],
  [24, 259],
  [28, 162],
  [48, 106],
  [88, 46],
  [148, 64],
  [157, 110],
  [172, 70],
  [464, 136],
  [490, 69],
  [605, 48],
  [1551, 88],
];

const TIPS = [
  ['DRIVING', 'Press F near any car to get in — or pull the driver out. Slow down before you jump out.'],
  ['HEAT', 'Crimes raise your heat level. Break line of sight with the police until the stars stop flashing.'],
  ['RESPRAY', 'Drive into a respray garage (green R on the map) to fix your car and lose the heat — it costs €120.'],
  ['MAP', 'Open the map with M. Click to set a waypoint and the GPS draws the fastest route on your minimap.'],
  ['JOBS', 'In a taxi or a delivery van, press J to start a job and earn money between missions.'],
  ['SAFEHOUSE', 'Walk into the white marker at the safehouse in Westend to save your game.'],
  ['POSTCARDS', '25 postcards are hidden next to the city’s towers. Each one pays €100.'],
  ['RADIO', 'Press Q in a car to switch radio stations. Mainhattan 128 never stops.'],
  ['WEATHER', 'The sun, moon and weather follow the real time and live weather in Frankfurt.'],
  ['CAMERA', 'V changes the camera (including a first-person view in cars). Hold C to look behind.'],
  ['HEALTH', 'Health slowly recovers to half. Green crosses restore it fully; armour waits at police stations.'],
];

function skylineSvg(mode) {
  const rng = createRng(7);
  const W = 1600,
    H = 600;
  const x = (v) => ((v + 1650) / 3400) * W;
  const parts = [];
  const body = mode === 'day' ? '#4c5b6b' : mode === 'night' ? '#05070d' : '#1a1222';
  const far = mode === 'day' ? '#8aa0b4' : mode === 'night' ? '#0b1224' : '#3b2440';
  // far low-rise band
  let px = 0;
  while (px < W) {
    const w = 18 + rng() * 40,
      h = 30 + rng() * 60;
    parts.push(`<rect x="${px.toFixed(0)}" y="${(H - h).toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" fill="${far}"/>`);
    px += w - 2;
  }
  // towers
  const windows = [];
  for (const [tx, th] of TOWERS) {
    const h = th * 1.9,
      w = 22 + (th / 260) * 26 + rng() * 10;
    const left = x(tx) - w / 2,
      top = H - h;
    parts.push(`<rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${body}"/>`);
    if (th > 180) parts.push(`<rect x="${(left + w / 2 - 1.2).toFixed(1)}" y="${(top - 26).toFixed(1)}" width="2.4" height="26" fill="${body}"/>`);
    if (mode === 'night') {
      for (let wy = top + 8; wy < H - 10; wy += 9) {
        for (let wx = left + 4; wx < left + w - 4; wx += 6)
          if (rng() < 0.22) windows.push(`<rect x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" width="2.6" height="3.6"/>`);
      }
      if (th > 180) parts.push(`<circle cx="${(left + w / 2).toFixed(1)}" cy="${(top - 26).toFixed(1)}" r="2.6" fill="#ff3b30"/>`);
    }
  }
  // near low-rise band
  px = 0;
  while (px < W) {
    const w = 26 + rng() * 50,
      h = 18 + rng() * 34;
    parts.push(`<rect x="${px.toFixed(0)}" y="${(H - h).toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" fill="${body}"/>`);
    px += w - 2;
  }
  const win = windows.length ? `<g fill="#ffd98a" opacity="0.85">${windows.join('')}</g>` : '';
  const sun =
    mode === 'dusk'
      ? '<circle cx="1180" cy="430" r="70" fill="#ffd27a" opacity="0.85"/>'
      : mode === 'night'
        ? '<circle cx="1320" cy="90" r="26" fill="#e9ecf5"/>'
        : '';
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice" aria-hidden="true">${sun}${parts.join('')}${win}</svg>`;
}

export class LoadingScreen {
  constructor() {
    this.root = document.getElementById('loading');
    this.scenes = [...this.root.querySelectorAll('.ld-scene')];
    for (const s of this.scenes) s.querySelector('.ken').innerHTML = skylineSvg([...s.classList].find((c) => c === 'dusk' || c === 'night' || c === 'day'));
    this.tipEl = document.getElementById('ld-tip');
    this.stageEl = document.getElementById('ld-stage');
    this.barEl = document.getElementById('ld-bar');
    this.sceneI = 0;
    this.tipI = Math.floor(Math.random() * TIPS.length);
    this.showTip();
    this.timers = [setInterval(() => this.nextScene(), 7000), setInterval(() => this.showTip(), 6000)];
  }
  nextScene() {
    this.scenes[this.sceneI].classList.remove('on');
    this.sceneI = (this.sceneI + 1) % this.scenes.length;
    this.scenes[this.sceneI].classList.add('on');
  }
  showTip() {
    const [h, t] = TIPS[this.tipI++ % TIPS.length];
    this.tipEl.style.opacity = 0;
    setTimeout(() => {
      this.tipEl.innerHTML = `<b>${h}</b>${t}`;
      this.tipEl.style.opacity = 1;
    }, 300);
  }
  /** @param {number} p progress 0..1 */
  progress(p, stage) {
    this.barEl.style.width = `${Math.round(p * 100)}%`;
    if (stage) this.stageEl.innerHTML = `${stage}<span class="ld-spinner"></span>`;
  }
  error(message) {
    this.stageEl.innerHTML = `<span class="ld-error">Error: ${message}</span>`;
  }
  hide() {
    this.progress(1, 'Ready');
    this.root.classList.add('done');
    setTimeout(() => {
      for (const t of this.timers) clearInterval(t);
      this.root.remove();
    }, 900);
  }
}
