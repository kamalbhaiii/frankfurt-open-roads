/**
 * Static game configuration: geography, road classes, quality presets and
 * the fixed points of interest (hospital, police, garages, safehouse).
 */

export const LAT = 50.1109;
export const LON = 8.6821;
export const WATER_Y = -2.6;
export const BED_Y = -8;
export const KERB = 0.15;
export const FIXED_STEP = 1 / 60;

/** Metres per degree around the map origin. */
const KX = 111320 * Math.cos((50.1112 * Math.PI) / 180);
const KZ = 110574;
/** Converts latitude/longitude to local world x/z (metres). */
export const toLocal = (lat, lon) => [(lon - 8.674) * KX, -(lat - 50.1112) * KZ];

/**
 * Road classes from the OSM extract: [width m, kind (0 car, 1 pedestrian), AI cruise speed m/s].
 */
export const RC = {
  0: [14, 0, 16],
  1: [12, 0, 15],
  2: [11, 0, 13],
  3: [9.5, 0, 12],
  4: [8, 0, 11],
  5: [6.5, 0, 9],
  6: [6.5, 0, 8],
  7: [4, 0, 0],
  8: [5, 1, 0],
  9: [6, 1, 0],
  10: [2.6, 1, 0],
  11: [2.2, 1, 0],
  12: [2, 1, 0],
  13: [2.4, 1, 0],
  14: [7, 0, 12],
  15: [7, 0, 12],
  16: [7, 0, 11],
  17: [7, 0, 10],
  18: [7, 0, 9],
  19: [3, 1, 0],
};
export const isCarRoad = (r) => RC[r.c][1] === 0 && RC[r.c][2] > 0;
export const roadWidth = (r) => (r.lanes && RC[r.c][1] === 0 ? Math.max(RC[r.c][0] * 0.6, r.lanes * 3.2 + 1) : RC[r.c][0]);

/**
 * Quality tiers (OWNER: lighting/rendering agent; other systems may only read them).
 * 'auto' resolves to one of these through detectQuality() (src/world/renderPipeline.js):
 * GPU name + WebGL caps + a short GPU benchmark. At runtime RenderPipeline keeps the frame
 * rate near `targetFps` by scaling the render resolution between `minScale` and 1 and, when
 * that is not enough, by switching off the most expensive effects (AO, planar reflections,
 * bloom) and shortening the shadow distance.
 *
 *  low     integrated / old GPUs, phones: no shadows, no post-processing (single direct pass,
 *          native MSAA), sky-driven IBL refreshed rarely, environment-mapped water.
 *  medium  mainstream laptops (Iris Xe, Radeon 680M, GTX 1050): 2-cascade sun shadows (1024),
 *          HDR post: bloom, colour grade, aerial haze, vignette, FXAA.
 *  high    dedicated GPUs (GTX 1660+, RTX x060, RX 6600, Apple M-series): 2048 cascades,
 *          GTAO ambient occlusion (half res), SMAA, planar river reflections (half res).
 *  ultra   fast GPUs (RTX x070+, RX 6800+): 3072 cascades and longer shadow range, AO at
 *          higher resolution, full-rate planar reflections, denser rain and trees.
 *
 * Fields used by other systems: trees, rain, far, traffic, peds, lampLights,
 * furnitureDistance, carDistance, pedDistance, anisotropy, pr.
 */
export const QUALITY = {
  low: {
    shadows: false,
    shadowSize: 1024, // per cascade (SunLight uses a 2-cascade atlas: 2·size × size)
    shadowDistance: 0, // metres covered by the shadow cascades
    shadowRadius: 1, // PCF filter radius (soft penumbra)
    pr: 1,
    minScale: 0.5, // let low-end GPUs trade pixel sharpness for a steadier frame rate
    targetFps: 50,
    post: false, // HDR post chain (bloom, grade, haze, AA); off = one direct render
    bloom: 0, // bloom strength (0 = off)
    ao: 0, // GTAO resolution scale (0 = off)
    aa: 'native', // 'native' (canvas MSAA, direct pass) | 'fxaa' | 'smaa'
    haze: false, // sun-tinted aerial perspective in post
    vignette: 0,
    dof: false, // depth of field (not used: off on every tier)
    reflections: 'env', // river: 'env' (sky IBL + sun glint) | 'planar' (mirror pass)
    reflectionScale: 0,
    reflectionEvery: 0, // render the planar reflection every N frames
    envInterval: 90, // seconds between sky → PMREM environment refreshes (and on big changes)
    envSize: 64, // PMREM cube face size
    cloudDetail: 3, // sky cloud fbm octaves
    trees: 0.35,
    rain: 2500,
    far: 2600,
    traffic: 13,
    peds: 33,
    lampLights: 4,
    furnitureDistance: 260,
    carDistance: 250,
    pedDistance: 110,
    anisotropy: 2,
  },
  medium: {
    shadows: true,
    shadowSize: 1024,
    shadowDistance: 150,
    shadowRadius: 2,
    pr: Math.min(globalThis.devicePixelRatio || 1, 1.5),
    minScale: 0.6,
    targetFps: 55,
    post: true,
    bloom: 0.35,
    ao: 0,
    aa: 'fxaa',
    haze: true,
    vignette: 0.18,
    dof: false,
    reflections: 'env',
    reflectionScale: 0,
    reflectionEvery: 0,
    envInterval: 45,
    envSize: 128,
    cloudDetail: 4,
    trees: 0.7,
    rain: 5000,
    far: 3800,
    traffic: 24,
    peds: 66,
    lampLights: 8,
    furnitureDistance: 380,
    carDistance: 340,
    pedDistance: 150,
    anisotropy: 4,
  },
  high: {
    shadows: true,
    shadowSize: 2048,
    shadowDistance: 280,
    shadowRadius: 2.5,
    pr: Math.min(globalThis.devicePixelRatio || 1, 2),
    minScale: 0.6,
    targetFps: 58,
    post: true,
    bloom: 0.4,
    ao: 0.5,
    aa: 'smaa',
    haze: true,
    vignette: 0.18,
    dof: false,
    reflections: 'planar',
    reflectionScale: 0.5,
    reflectionEvery: 2,
    envInterval: 25,
    envSize: 128,
    cloudDetail: 5,
    trees: 1,
    rain: 8000,
    far: 5200,
    traffic: 31,
    peds: 88,
    lampLights: 12,
    furnitureDistance: 520,
    carDistance: 420,
    pedDistance: 200,
    anisotropy: 8,
  },
  ultra: {
    shadows: true,
    shadowSize: 3072,
    shadowDistance: 450,
    shadowRadius: 3,
    pr: Math.min(globalThis.devicePixelRatio || 1, 2),
    minScale: 0.7,
    targetFps: 58,
    post: true,
    bloom: 0.42,
    ao: 0.75,
    aa: 'smaa',
    haze: true,
    vignette: 0.18,
    dof: false,
    reflections: 'planar',
    reflectionScale: 0.75,
    reflectionEvery: 1,
    envInterval: 15,
    envSize: 256,
    cloudDetail: 6,
    trees: 1.3,
    rain: 10000,
    far: 6500,
    traffic: 40,
    peds: 121,
    lampLights: 16,
    furnitureDistance: 700,
    carDistance: 520,
    pedDistance: 260,
    anisotropy: 16,
  },
};

export const DISTRICTS = [
  ['Bankenviertel', 50.1112, 8.6725],
  ['Altstadt', 50.1104, 8.6826],
  ['Innenstadt', 50.1143, 8.683],
  ['Westend', 50.1195, 8.664],
  ['Bahnhofsviertel', 50.108, 8.668],
  ['Sachsenhausen', 50.103, 8.686],
  ['Museumsufer', 50.1048, 8.6765],
  ['Gutleutviertel', 50.1033, 8.664],
  ['Messe', 50.1115, 8.65],
  ['Gallus', 50.105, 8.652],
  ['Nordend', 50.1205, 8.689],
  ['Ostend', 50.112, 8.696],
  ['Westend-Süd', 50.115, 8.664],
].map(([n, la, lo]) => {
  const [x, z] = toLocal(la, lo);
  return { n, x, z };
});

/**
 * Fixed services. Game locations (not real facilities); positions are snapped
 * to the nearest drivable road at runtime.
 * kind: hospital | police | garage (respray + repair) | safehouse (save game)
 */
export const SERVICES = [
  { id: 'hospital_nord', kind: 'hospital', name: 'Krankenhaus Nord', lat: 50.1205, lon: 8.6815 },
  { id: 'hospital_sued', kind: 'hospital', name: 'Krankenhaus Süd', lat: 50.1025, lon: 8.6845 },
  { id: 'police_west', kind: 'police', name: 'Polizeirevier West', lat: 50.1165, lon: 8.6585 },
  { id: 'police_ost', kind: 'police', name: 'Polizeirevier Ost', lat: 50.1108, lon: 8.6905 },
  { id: 'garage_gallus', kind: 'garage', name: 'Lackiererei Gallus', lat: 50.1062, lon: 8.6545 },
  { id: 'garage_ost', kind: 'garage', name: 'Werkstatt Ostend', lat: 50.1135, lon: 8.6985 },
  { id: 'safehouse', kind: 'safehouse', name: 'Safehouse · Westend', lat: 50.1178, lon: 8.6705 },
];

/** Vehicle spawn weights for ambient traffic and parked cars. */
export const CAR_KINDS = { sedan: 3, taxi: 3, hatchback: 3, estate: 2, suv: 2, coupe: 1, van: 1.4, police: 0.3 };
export const CAR_PAINTS = [
  0x1d2b44, 0x8c1c1c, 0xdedede, 0x222222, 0x506070, 0x2f5a3a, 0x7c6a4e, 0x9aa3ab, 0x1a4f7a, 0x3c3c3c, 0xb8b8b8, 0x5a1f2b, 0x0f0f10, 0xc4c7cc,
];

/** Economy & penalties. */
export const ECONOMY = { startMoney: 250, hospitalFee: 0.1, hospitalMin: 100, arrestFee: 0.15, arrestMin: 150, respray: 120, repair: 60 };

/** Wanted level tuning: points needed for each level, police units per level, search radius. */
export const WANTED = {
  thresholds: [0, 10, 40, 90, 160, 250],
  units: [0, 1, 2, 3, 4, 5],
  searchRadius: [0, 130, 180, 240, 300, 380],
  cooldown: [0, 12, 16, 20, 25, 30],
};

export const STORAGE_KEYS = { settings: 'fs.settings.v1', save: (slot) => `fs.save.v1.${slot}` };
export const SAVE_SLOTS = 3;
