/**
 * Procedural canvas textures for the Hauptbahnhof (no downloads): sandstone ashlar, granite floor,
 * glazing bars, shop fronts, signs/lettering atlas, vehicle liveries, and the live departure boards.
 * Everything is generated once at build time.
 */
import * as THREE from 'three';
import { rnd } from '../../core/math.js';

const canvas = (w, h, cpu = false) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  // cpu: a software canvas, so re-uploading it to WebGL never waits on a GPU readback
  return [c, c.getContext('2d', cpu ? { willReadFrequently: true } : undefined)];
};
const tex = (c, { repeat = true, srgb = true, aniso = 4 } = {}) => {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
};
const noise = (g, w, h, n, a) => {
  for (let i = 0; i < n; i++) {
    const v = rnd() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${a * rnd()})`;
    g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 3, 1 + rnd() * 3);
  }
};

/** Sandstone ashlar, 512 px = 4 m (uv = metres * 0.25). Courses of 0.5 m. */
export function stoneTexture() {
  const [c, g] = canvas(512, 512);
  g.fillStyle = '#d9c39c';
  g.fillRect(0, 0, 512, 512);
  const course = 64;
  for (let y = 0; y < 512; y += course) {
    let x = -((y / course) % 2) * 48;
    while (x < 512) {
      const w = 96 + Math.floor(rnd() * 3) * 32;
      const l = 0.92 + rnd() * 0.12;
      g.fillStyle = `rgb(${Math.round(218 * l)},${Math.round(192 * l)},${Math.round(148 * l)})`;
      g.fillRect(x + 2, y + 2, w - 3, course - 3);
      g.fillStyle = 'rgba(90,75,55,0.45)';
      g.fillRect(x, y, 2, course);
      x += w;
    }
    g.fillStyle = 'rgba(90,75,55,0.55)';
    g.fillRect(0, y, 512, 2);
  }
  noise(g, 512, 512, 9000, 0.08);
  // weathering streaks
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(60,55,45,${0.03 + rnd() * 0.05})`;
    g.fillRect(rnd() * 512, rnd() * 512, 2 + rnd() * 6, 30 + rnd() * 120);
  }
  return tex(c);
}

/** Polished granite floor tiles, 512 px = 2 m (uv = metres * 0.5). */
export function floorTexture() {
  const [c, g] = canvas(512, 512);
  const n = 4,
    s = 512 / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const l = 0.9 + rnd() * 0.12;
      const dark = (i + j) % 2 === 0;
      const b = dark ? 150 : 178;
      g.fillStyle = `rgb(${Math.round(b * l)},${Math.round(b * l * 0.98)},${Math.round(b * l * 0.95)})`;
      g.fillRect(i * s, j * s, s, s);
    }
  noise(g, 512, 512, 14000, 0.12);
  g.fillStyle = 'rgba(40,40,40,0.5)';
  for (let i = 0; i <= n; i++) {
    g.fillRect(i * s - 1, 0, 2, 512);
    g.fillRect(0, i * s - 1, 512, 2);
  }
  return tex(c);
}

/** Glazing: dark-green bars with pale panes (alpha), 256 px = 3 m (uv = metres / 3). */
export function glassTexture() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = 'rgba(200,222,230,0.28)';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 30; i++) {
    g.fillStyle = `rgba(255,255,255,${rnd() * 0.06})`;
    g.fillRect(rnd() * 256, rnd() * 256, 40, 3);
  }
  g.fillStyle = 'rgba(48,62,60,1)';
  for (const x of [0, 128]) g.fillRect(x, 0, 9, 256);
  g.fillRect(0, 0, 256, 7);
  g.fillStyle = 'rgba(48,62,60,0.9)';
  g.fillRect(0, 128, 256, 4);
  return tex(c, { srgb: true });
}

const SHOPS = [
  ['Bäckerei', '#c8823a', '#f6e3c6', 'bakery'],
  ['Kiosk', '#2c5d9e', '#e8eef7', 'kiosk'],
  ['Reisezentrum', '#b8122b', '#ffffff', 'travel'],
  ['Apotheke', '#1e8a4a', '#eaf6ee', 'pharmacy'],
  ['Café Bahnhof', '#5a3b2a', '#f3e6d6', 'cafe'],
  ['Bücher & Presse', '#263238', '#f2efe6', 'books'],
  ['Blumen', '#7a2e6b', '#fbe9f6', 'flowers'],
  ['Imbiss', '#d1491f', '#fff3e0', 'food'],
];
export const SHOP_COUNT = SHOPS.length;

/** Shop-front atlas: 4 x 2 cells of 256 px; each cell = one front (fascia + shop window). */
export function shopTexture() {
  const [c, g] = canvas(1024, 512);
  SHOPS.forEach(([name, col, light, kind], i) => {
    const x = (i % 4) * 256,
      y = Math.floor(i / 4) * 256;
    // glass shop window with a warm lit interior
    const grd = g.createLinearGradient(0, y + 60, 0, y + 256);
    grd.addColorStop(0, light);
    grd.addColorStop(1, '#8a7a66');
    g.fillStyle = grd;
    g.fillRect(x, y + 56, 256, 200);
    // interior hints: shelves / counter
    g.fillStyle = 'rgba(60,40,30,0.55)';
    for (let k = 0; k < 3; k++) g.fillRect(x + 16, y + 92 + k * 34, 224, 6);
    g.fillStyle = col;
    g.fillRect(x + 20, y + 196, 216, 40);
    if (kind === 'bakery' || kind === 'food' || kind === 'cafe')
      for (let k = 0; k < 9; k++) {
        g.fillStyle = ['#d9a05b', '#b8742e', '#f0d29a'][k % 3];
        g.beginPath();
        g.arc(x + 36 + k * 22, y + 186, 9, 0, Math.PI * 2);
        g.fill();
      }
    if (kind === 'flowers')
      for (let k = 0; k < 14; k++) {
        g.fillStyle = ['#e23d6b', '#f7c21b', '#ffffff', '#b04ad6'][k % 4];
        g.beginPath();
        g.arc(x + 24 + k * 15, y + 190 - (k % 3) * 8, 7, 0, Math.PI * 2);
        g.fill();
      }
    if (kind === 'books' || kind === 'kiosk')
      for (let k = 0; k < 40; k++) {
        g.fillStyle = `hsl(${rnd() * 360},55%,${40 + rnd() * 25}%)`;
        g.fillRect(x + 18 + (k % 20) * 11, y + 70 + Math.floor(k / 20) * 34, 9, 26);
      }
    // mullions + door
    g.fillStyle = '#2b2f31';
    for (const mx of [0, 84, 170, 252]) g.fillRect(x + mx, y + 56, 4, 200);
    g.fillRect(x, y + 250, 256, 6);
    // fascia
    g.fillStyle = col;
    g.fillRect(x, y, 256, 56);
    g.fillStyle = '#ffffff';
    g.font = `bold ${name.length > 12 ? 24 : 30}px Arial, Helvetica, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, x + 128, y + 29);
  });
  return tex(c, { repeat: false });
}

/**
 * Sign atlas 1024 x 1024 (unlit material, alpha-tested):
 *   rows 0-127     "HAUPTBAHNHOF" lettering (bronze on transparent)
 *   rows 128-255   blue station-name sign "Frankfurt (Main) Hbf" | "Fernbusterminal" sign (green)
 *   rows 256-511   platform number cells: 24 cells of 128 x 64 (8 per row, 3 rows)
 *   rows 512-639   clock face (128 x 128 at x 0) | bus bay numbers 1-8 (64 x 64 cells at x 128..)
 *   rows 640-767   ticket machine / info panels
 *   rows 768-1023  solid colours (x 0-63 white, 64-127 dark, 128-191 red, 192-255 bronze)
 */
export const SIGN_UV = {
  lettering: [0, 1 - 128 / 1024, 1, 1],
  hbfSign: [0, 1 - 256 / 1024, 0.5, 1 - 128 / 1024],
  busSign: [0.5, 1 - 256 / 1024, 1, 1 - 128 / 1024],
  platform: (i) => {
    const cx = i % 8,
      cy = Math.floor(i / 8);
    return [(cx * 128) / 1024, 1 - (256 + (cy + 1) * 64) / 1024, ((cx + 1) * 128) / 1024, 1 - (256 + cy * 64) / 1024];
  },
  clock: [0, 1 - 640 / 1024, 128 / 1024, 1 - 512 / 1024],
  bay: (i) => [(128 + i * 64) / 1024, 1 - 576 / 1024, (128 + (i + 1) * 64) / 1024, 1 - 512 / 1024],
  machine: [0, 1 - 768 / 1024, 128 / 1024, 1 - 640 / 1024],
  info: [128 / 1024, 1 - 768 / 1024, 384 / 1024, 1 - 640 / 1024],
  white: [8 / 1024, 1 - 1016 / 1024, 56 / 1024, 1 - 776 / 1024],
  dark: [72 / 1024, 1 - 1016 / 1024, 120 / 1024, 1 - 776 / 1024],
  red: [136 / 1024, 1 - 1016 / 1024, 184 / 1024, 1 - 776 / 1024],
  bronze: [200 / 1024, 1 - 1016 / 1024, 248 / 1024, 1 - 776 / 1024],
};

export function signTexture() {
  const [c, g] = canvas(1024, 1024);
  g.clearRect(0, 0, 1024, 1024);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // lettering
  g.font = 'bold 104px "Times New Roman", Georgia, serif';
  g.fillStyle = '#3b3326';
  g.fillText('HAUPTBAHNHOF', 512 + 3, 68 + 3);
  g.fillStyle = '#b8954d';
  g.fillText('HAUPTBAHNHOF', 512, 68);
  // station name sign (blue, white text)
  g.fillStyle = '#0d3b78';
  g.fillRect(0, 128, 512, 128);
  g.fillStyle = '#ffffff';
  g.fillRect(6, 134, 500, 4);
  g.fillRect(6, 246, 500, 4);
  g.font = 'bold 52px Arial, Helvetica, sans-serif';
  g.fillText('Frankfurt (Main) Hbf', 256, 192);
  // bus terminal sign
  g.fillStyle = '#2f7d1f';
  g.fillRect(512, 128, 512, 128);
  g.fillStyle = '#ffffff';
  g.font = 'bold 66px Arial, Helvetica, sans-serif';
  g.fillText('Fernbusterminal', 768, 178);
  g.font = '28px Arial, Helvetica, sans-serif';
  g.fillText('Long-distance coaches · Bays 1–8', 768, 230);
  // platform numbers (white on blue, DB-style generic)
  for (let i = 0; i < 24; i++) {
    const x = (i % 8) * 128,
      y = 256 + Math.floor(i / 8) * 64;
    g.fillStyle = '#ffffff';
    g.fillRect(x, y, 128, 64);
    g.fillStyle = '#0d3b78';
    g.fillRect(x + 4, y + 4, 120, 56);
    g.fillStyle = '#ffffff';
    g.font = 'bold 44px Arial, Helvetica, sans-serif';
    g.fillText(String(i + 1), x + 64, y + 34);
  }
  // clock face
  g.fillStyle = '#f4f1e8';
  g.beginPath();
  g.arc(64, 576, 62, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#1b1b1b';
  g.lineWidth = 4;
  g.stroke();
  g.fillStyle = '#1b1b1b';
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    g.save();
    g.translate(64 + Math.sin(a) * 50, 576 - Math.cos(a) * 50);
    g.rotate(a);
    g.fillRect(-3, -8, 6, k % 3 === 0 ? 18 : 12);
    g.restore();
  }
  // bus bays
  for (let i = 0; i < 8; i++) {
    const x = 128 + i * 64;
    g.fillStyle = '#2f7d1f';
    g.fillRect(x + 2, 514, 60, 60);
    g.fillStyle = '#ffffff';
    g.font = 'bold 40px Arial, Helvetica, sans-serif';
    g.fillText(String(i + 1), x + 32, 546);
  }
  // ticket machine face
  g.fillStyle = '#c4161c';
  g.fillRect(0, 640, 128, 128);
  g.fillStyle = '#1c2a36';
  g.fillRect(16, 656, 96, 60);
  g.fillStyle = '#ffffff';
  g.font = 'bold 18px Arial, sans-serif';
  g.fillText('Tickets', 64, 740);
  // info panel
  g.fillStyle = '#e9edf0';
  g.fillRect(128, 640, 256, 128);
  g.fillStyle = '#0d3b78';
  g.fillRect(128, 640, 256, 30);
  g.fillStyle = '#ffffff';
  g.font = 'bold 20px Arial, sans-serif';
  g.fillText('i  Information', 256, 656);
  g.fillStyle = '#333';
  for (let k = 0; k < 5; k++) g.fillRect(150, 684 + k * 15, 120 + rnd() * 90, 6);
  // solid colours
  for (const [x, col] of [
    [0, '#ffffff'],
    [64, '#202326'],
    [128, '#c8102e'],
    [192, '#8c6a32'],
  ]) {
    g.fillStyle = col;
    g.fillRect(x, 768, 64, 256);
  }
  return tex(c, { repeat: false });
}

/**
 * Vehicle livery atlas 1024 x 2048 (16 rows). Each livery row is 128 px tall; x spans one car length.
 * The row's bottom (v0) is the underframe, the top (v1) the roof edge. Lettering is laid out for the
 * right-hand side; cars lofted with mirrorLeft get readable lettering on both sides.
 */
export const LIVERY = {
  ice: 0,
  iceCab: 1,
  regio: 2,
  loco: 3,
  sbahn: 4,
  flixbus: 5,
  blablabus: 6,
  regiojet: 7,
  flixCoach: 8,
  flixLoco: 9,
  ic2: 10,
  ic2Loco: 11,
  rb: 12,
};
const ROWS = 16;
export const liveryRect = (row) => [0, 1 - (row + 1) / ROWS, 1, 1 - row / ROWS];

export function liveryTexture() {
  const [c, g] = canvas(1024, 128 * ROWS);
  const row = (r, fn) => {
    g.save();
    g.translate(0, r * 128);
    fn();
    g.restore();
  };
  const windows = (y, h, n, w, gap0, col = '#1d2a33') => {
    g.fillStyle = col;
    const pitch = (1024 - gap0 * 2) / n;
    for (let i = 0; i < n; i++) g.fillRect(gap0 + i * pitch + (pitch - w) / 2, y, w, h);
  };
  const text = (s, x, y, px, col, weight = 'bold') => {
    g.fillStyle = col;
    g.font = `${weight} ${px}px Arial, Helvetica, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s, x, y);
  };
  // DB logo: red rounded frame, white field, red "DB"
  const dbLogo = (x, y, h = 22) => {
    const w = h * 1.45;
    g.fillStyle = '#ec0016';
    g.fillRect(x - w / 2, y - h / 2, w, h);
    g.fillStyle = '#ffffff';
    g.fillRect(x - w / 2 + h * 0.12, y - h / 2 + h * 0.12, w - h * 0.24, h - h * 0.24);
    text('DB', x, y + 1, h * 0.62, '#ec0016');
  };
  const underframe = (y = 112, col = '#3a3d40') => {
    g.fillStyle = col;
    g.fillRect(0, y, 1024, 128 - y);
  };
  const cabEnds = (col = '#26323a') => {
    g.fillStyle = col;
    g.fillRect(40, 30, 90, 34);
    g.fillRect(894, 30, 90, 34);
  };
  // y in the row: 0 = roof edge, 128 = underframe
  // ICE: white, dark window band, red stripe, ICE lettering + DB logo
  row(LIVERY.ice, () => {
    g.fillStyle = '#f2f3f2';
    g.fillRect(0, 0, 1024, 128);
    g.fillStyle = '#1f2a30';
    g.fillRect(0, 34, 1024, 30);
    windows(36, 26, 12, 60, 40, '#33505e');
    g.fillStyle = '#ec0016';
    g.fillRect(0, 76, 1024, 9);
    g.fillStyle = '#c9cdd0';
    for (const x of [30, 980]) g.fillRect(x, 30, 22, 80); // doors
    text('ICE', 170, 97, 20, '#8a9196');
    dbLogo(850, 97, 18);
    underframe(112, '#5b6266');
  });
  row(LIVERY.iceCab, () => {
    g.fillStyle = '#f2f3f2';
    g.fillRect(0, 0, 1024, 128);
    g.fillStyle = '#1f2a30';
    g.fillRect(0, 34, 640, 30);
    windows(36, 26, 6, 50, 60, '#33505e');
    g.fillStyle = '#ec0016';
    g.fillRect(0, 76, 1024, 9);
    g.fillStyle = '#20282c';
    g.fillRect(860, 26, 164, 36); // cab window band towards the nose (+x end)
    text('ICE', 300, 98, 22, '#8a9196');
    dbLogo(720, 98, 20);
    underframe(112, '#5b6266');
  });
  // RE: DB Regio double-deck, verkehrsrot, light grey doors, two window rows
  row(LIVERY.regio, () => {
    g.fillStyle = '#c4161c';
    g.fillRect(0, 0, 1024, 128);
    g.fillStyle = '#e8e8e8';
    g.fillRect(0, 0, 1024, 10);
    windows(18, 24, 14, 50, 30, '#26323a');
    windows(64, 24, 14, 50, 30, '#26323a');
    g.fillStyle = '#b4b8ba';
    for (const x of [200, 790]) g.fillRect(x, 60, 34, 56);
    g.fillStyle = '#ffffff';
    g.fillRect(400, 94, 220, 18);
    text('DB Regio  RE', 510, 103, 14, '#c4161c');
    underframe(116);
  });
  // DB electric locomotive: red, white stripe, cab windows at both ends
  row(LIVERY.loco, () => {
    g.fillStyle = '#c4161c';
    g.fillRect(0, 0, 1024, 128);
    g.fillStyle = '#e8e8e8';
    g.fillRect(0, 0, 1024, 12);
    cabEnds();
    g.fillStyle = '#26323a';
    for (let i = 0; i < 6; i++) g.fillRect(300 + i * 70, 34, 40, 24);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 80, 1024, 5);
    dbLogo(512, 98, 20);
    underframe();
  });
  // S-Bahn Rhein-Main: red lower body, white upper, grey doors, green S roundel
  row(LIVERY.sbahn, () => {
    g.fillStyle = '#f0f0ee';
    g.fillRect(0, 0, 1024, 128);
    g.fillStyle = '#c4161c';
    g.fillRect(0, 70, 1024, 46);
    windows(28, 34, 10, 66, 30, '#22303a');
    g.fillStyle = '#b8bcbf';
    for (const x of [120, 390, 630, 880]) g.fillRect(x, 24, 40, 92);
    for (const x of [260, 760]) {
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(x, 92, 14, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#008d4f';
      g.beginPath();
      g.arc(x, 92, 12, 0, Math.PI * 2);
      g.fill();
      text('S', x, 93, 18, '#ffffff');
    }
    underframe(116);
  });
  // RB: DB Regio EMU, red with a light grey window band
  row(LIVERY.rb, () => {
    g.fillStyle = '#c4161c';
    g.fillRect(0, 0, 1024, 128);
    g.fillStyle = '#d7dadc';
    g.fillRect(0, 18, 1024, 50);
    windows(24, 38, 10, 66, 30, '#22303a');
    g.fillStyle = '#9ea3a6';
    for (const x of [120, 390, 630, 880]) g.fillRect(x, 20, 40, 96);
    text('RB', 255, 92, 24, '#ffffff');
    dbLogo(760, 92, 20);
    underframe(116);
  });
  // FlixTrain: lime green, big white lettering, dark window band
  row(LIVERY.flixCoach, () => {
    g.fillStyle = '#73d700';
    g.fillRect(0, 0, 1024, 128);
    g.fillStyle = '#1f2a30';
    g.fillRect(0, 32, 1024, 30);
    windows(34, 26, 11, 62, 40, '#2e4a3a');
    g.fillStyle = '#5bb000';
    for (const x of [30, 972]) g.fillRect(x, 28, 22, 84);
    text('FLIXTRAIN', 512, 90, 30, '#ffffff', '900');
    underframe(112, '#40464a');
  });
  row(LIVERY.flixLoco, () => {
    g.fillStyle = '#73d700';
    g.fillRect(0, 0, 1024, 128);
    cabEnds();
    g.fillStyle = '#ff8a00';
    g.fillRect(0, 98, 1024, 8);
    text('FLIXTRAIN', 512, 66, 34, '#ffffff', '900');
    underframe(112, '#40464a');
  });
  // Intercity 2: white double-deck, red stripe at the bottom, grey-blue windows
  row(LIVERY.ic2, () => {
    g.fillStyle = '#f2f3f2';
    g.fillRect(0, 0, 1024, 128);
    windows(16, 26, 14, 52, 30, '#2c3e4a');
    windows(60, 26, 14, 52, 30, '#2c3e4a');
    g.fillStyle = '#ec0016';
    g.fillRect(0, 98, 1024, 10);
    g.fillStyle = '#c9cdd0';
    for (const x of [200, 790]) g.fillRect(x, 58, 34, 40);
    text('IC', 120, 103, 12, '#ffffff');
    underframe(112, '#5b6266');
  });
  row(LIVERY.ic2Loco, () => {
    g.fillStyle = '#f2f3f2';
    g.fillRect(0, 0, 1024, 128);
    cabEnds();
    g.fillStyle = '#26323a';
    for (let i = 0; i < 6; i++) g.fillRect(300 + i * 70, 34, 40, 24);
    g.fillStyle = '#ec0016';
    g.fillRect(0, 86, 1024, 12);
    dbLogo(512, 72, 18);
    underframe(112, '#5b6266');
  });
  // coaches (one bus side per row): windows high, livery colour, operator lettering
  const coach = (r, body, accent, label, ink, weight, px) =>
    row(r, () => {
      g.fillStyle = body;
      g.fillRect(0, 0, 1024, 128);
      g.fillStyle = '#1b2329';
      g.fillRect(70, 14, 900, 44);
      g.fillStyle = '#2b3a44';
      for (let i = 0; i < 9; i++) g.fillRect(80 + i * 100, 16, 92, 40);
      g.fillStyle = '#1b2329';
      g.fillRect(0, 10, 66, 60); // windscreen / rear window at both ends
      g.fillRect(958, 10, 66, 60);
      g.fillRect(150, 62, 44, 56); // door
      g.fillStyle = accent;
      g.fillRect(0, 100, 1024, 12);
      text(label, 580, 81, px, ink, weight);
      g.fillStyle = '#1a1a1a';
      g.fillRect(0, 118, 1024, 10);
    });
  coach(LIVERY.flixbus, '#73d700', '#ff8a00', 'FlixBus', '#ffffff', '900', 40);
  coach(LIVERY.blablabus, '#ffffff', '#00aff5', 'BlaBlaBus', '#054752', '900', 38);
  coach(LIVERY.regiojet, '#fcd600', '#1a1a1a', 'RegioJet', '#1a1a1a', 'bold', 38);
  return tex(c, { repeat: false, aniso: 4 });
}

// ------------------------------------------------------------------ departure boards
const LINES = [
  ['ICE', 'Berlin Hbf', 'über Fulda – Kassel-Wilhelmshöhe'],
  ['ICE', 'München Hbf', 'über Würzburg – Nürnberg'],
  ['ICE', 'Köln Hbf', 'über Frankfurt Flughafen'],
  ['ICE', 'Hamburg-Altona', 'über Hannover Hbf'],
  ['ICE', 'Basel SBB', 'über Mannheim – Karlsruhe'],
  ['IC', 'Stuttgart Hbf', 'über Darmstadt – Heidelberg'],
  ['ICE', 'Amsterdam Centraal', 'über Köln – Düsseldorf'],
  ['ICE', 'Paris Est', 'über Mannheim – Saarbrücken'],
  ['IC', 'Dresden Hbf', 'über Erfurt – Leipzig'],
  ['FLX 15', 'Hamburg Hbf', 'über Kassel – Göttingen'],
  ['FLX 30', 'Berlin Hbf', 'über Hannover – Wolfsburg'],
  ['RE 30', 'Kassel Hbf', 'über Friedberg – Gießen'],
  ['RE 50', 'Fulda', 'über Hanau – Gelnhausen'],
  ['RB 58', 'Aschaffenburg', 'über Offenbach'],
  ['RE 2', 'Koblenz Hbf', 'über Mainz – Bingen'],
  ['RB 68', 'Heidelberg Hbf', 'über Darmstadt'],
  ['RE 60', 'Mannheim Hbf', 'über Darmstadt – Bensheim'],
  ['RB 10', 'Wiesbaden Hbf', 'über Frankfurt-Höchst'],
  ['RE 9', 'Mainz Hbf', 'über Rüsselsheim'],
  ['RB 75', 'Darmstadt Hbf', 'über Frankfurt-Sportfeld'],
];

/**
 * Live departure boards on one 1024 x 512 canvas:
 *   y 0-319    the big concourse board (8 departures)
 *   y 320-511  24 platform displays, 4 columns x 6 rows of 256 x 32 px
 * Redrawn only when the Frankfurt minute changes (and throttled by the caller).
 */
export class DepartureBoards {
  constructor() {
    const [c, g] = canvas(1024, 512, true);
    this.c = c;
    this.g = g;
    this.texture = tex(c, { repeat: false, aniso: 1 });
    this.texture.generateMipmaps = false; // cheap re-uploads (redrawn once per game minute at most)
    this.texture.minFilter = THREE.LinearFilter;
    this.lastKey = '';
    // a fixed hourly pattern: each line departs at a minute offset from a platform
    this.pattern = [];
    for (let i = 0; i < 48; i++) {
      const L = LINES[i % LINES.length];
      this.pattern.push({ line: L, minute: (i * 37 + 7) % 60, track: 1 + ((i * 7 + 3) % 24), delay: i % 7 === 3 ? 5 + (i % 3) * 5 : 0, num: 500 + i * 17 });
    }
  }
  static bigUV() {
    return [0, 1 - 320 / 512, 1, 1];
  }
  /** Platform display rect in the atlas for track index 0..23. */
  static trackUV(i) {
    const cx = i % 4,
      cy = Math.floor(i / 4);
    return [cx * 0.25, 1 - (320 + (cy + 1) * 32) / 512, (cx + 1) * 0.25, 1 - (320 + cy * 32) / 512];
  }
  update(hour, minute) {
    const key = `${hour}:${minute}`;
    if (key === this.lastKey) return false;
    this.lastKey = key;
    const now = hour * 60 + minute;
    const deps = [];
    for (let h = 0; h < 2; h++)
      for (const p of this.pattern) {
        const t = (Math.floor(now / 60) + h) * 60 + p.minute;
        if (t >= now) deps.push({ ...p, t });
      }
    deps.sort((a, b) => a.t - b.t);
    const g = this.g;
    const fmt = (t) => `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    const font = (s, b = true) => (g.font = `${b ? 'bold ' : ''}${s}px Arial, Helvetica, sans-serif`);
    g.textBaseline = 'middle';
    // ---- big board
    g.fillStyle = '#0b1f4a';
    g.fillRect(0, 0, 1024, 320);
    g.fillStyle = '#ffffff';
    g.textAlign = 'left';
    font(26);
    g.fillText('Abfahrt  Departure', 16, 22);
    g.textAlign = 'right';
    g.fillText(fmt(now), 1008, 22);
    g.fillRect(0, 42, 1024, 2);
    g.textAlign = 'left';
    for (let i = 0; i < 8; i++) {
      const d = deps[i];
      const y = 64 + i * 32;
      if (i % 2) {
        g.fillStyle = 'rgba(255,255,255,0.06)';
        g.fillRect(0, y - 16, 1024, 32);
      }
      g.fillStyle = '#ffffff';
      font(22);
      g.fillText(fmt(d.t), 16, y);
      g.fillStyle = d.line[0].startsWith('IC') ? '#ff5a68' : '#ffffff';
      g.fillText(d.line[0].includes(' ') ? d.line[0] : `${d.line[0]} ${d.num}`, 96, y);
      g.fillStyle = '#ffffff';
      g.fillText(d.line[1], 236, y);
      font(15, false);
      g.fillStyle = '#a9bde0';
      g.fillText(d.line[2], 500, y);
      if (d.delay) {
        g.fillStyle = '#ffd23f';
        font(18);
        g.fillText(`ca. +${d.delay}`, 800, y);
      }
      g.fillStyle = '#ffffff';
      font(24);
      g.fillText(String(d.track), 950, y);
    }
    // ---- platform displays
    const used = new Set();
    for (let i = 0; i < 24; i++) {
      const x = (i % 4) * 256,
        y = 320 + Math.floor(i / 4) * 32;
      g.fillStyle = '#0b1f4a';
      g.fillRect(x, y, 256, 32);
      g.fillStyle = '#ffffff';
      g.fillRect(x, y, 256, 1);
      const d = deps.find((q) => q.track === i + 1 && !used.has(q));
      g.textAlign = 'left';
      if (d) {
        used.add(d);
        font(15);
        g.fillText(fmt(d.t), x + 4, y + 16);
        g.fillStyle = d.line[0].startsWith('IC') ? '#ff5a68' : '#ffffff';
        g.fillText(d.line[0].split(' ')[0], x + 50, y + 16);
        g.fillStyle = '#ffffff';
        g.fillText(d.line[1].slice(0, 15), x + 88, y + 16);
      } else {
        font(14, false);
        g.fillStyle = '#a9bde0';
        g.fillText('Bitte nicht einsteigen', x + 4, y + 16);
      }
      g.textAlign = 'right';
      g.fillStyle = '#ffd23f';
      font(18);
      g.fillText(String(i + 1), x + 252, y + 16);
    }
    this.texture.needsUpdate = true;
    return true;
  }
}
