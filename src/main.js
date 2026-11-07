/**
 * FRANKFURT: OPEN ROADS — open-world browser game set in Frankfurt's real city centre.
 * Entry point: boots the renderer, loads data behind the loading screen, builds the
 * world and systems, shows the title menu and runs the main loop.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ctx } from './core/context.js';
import { QUALITY, RC, isCarRoad, roadWidth, DISTRICTS } from './core/config.js';
import { settings } from './core/settings.js';
import { input } from './core/input.js';
import { events } from './core/events.js';
import { rnd, pip } from './core/math.js';
import { loadModels, loadCity, loadStreets } from './world/data.js';
import { buildCity } from './world/city.js';
import { uniforms } from './world/materials.js';
import { Physics } from './world/physics.js';
import { Furniture } from './world/furniture.js';
import { Environment } from './world/environment.js';
import { RoadNetwork } from './world/roadNetwork.js';
import { VehicleManager, pickKind } from './actors/vehicles.js';
import { Traffic } from './actors/traffic.js';
import { Pedestrians } from './actors/pedestrians.js';
import { Player } from './actors/player.js';
import { Police } from './actors/police.js';
import { WantedSystem } from './gameplay/wanted.js';
import { Stats } from './gameplay/stats.js';
import { Blips, Markers } from './gameplay/markers.js';
import { MissionRunner } from './gameplay/missions.js';
import { Services } from './gameplay/services.js';
import { Gps } from './gameplay/gps.js';
import { CameraRig } from './gameplay/cameraRig.js';
import { Game } from './gameplay/game.js';
import { parkingSpot } from './gameplay/places.js';
import { AudioManager } from './audio/audio.js';
import { LoadingScreen } from './ui/loading.js';
import { Hud } from './ui/hud.js';
import { Minimap } from './ui/minimap.js';
import { MapRenderer } from './ui/mapRenderer.js';
import { MapScreen } from './ui/mapScreen.js';
import { Menus } from './ui/menus.js';
import { assets } from './core/assets.js';
import { RenderPipeline, detectQuality } from './world/renderPipeline.js';

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));
const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && innerWidth < 1100);

/** Resolves the 'auto' quality setting to a tier for this machine. */
const resolveQuality = (setting, renderer) => (setting === 'auto' || !QUALITY[setting] ? detectQuality(renderer) : setting);

function setupRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: !isMobile(), powerPreference: 'high-performance' });
  ctx.quality = resolveQuality(settings.get('quality'), renderer);
  const q = QUALITY[ctx.quality];
  assets.maxAnisotropy = Math.min(q.anisotropy ?? 8, renderer.capabilities.getMaxAnisotropy());
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(q.pr);
  renderer.shadowMap.enabled = q.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('app').appendChild(renderer.domElement);
  ctx.renderer = renderer;
  ctx.scene = new THREE.Scene();
  ctx.camera = new THREE.PerspectiveCamera(settings.get('fov'), innerWidth / innerHeight, 0.4, q.far);
  ctx.scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  addEventListener('resize', () => {
    ctx.camera.aspect = innerWidth / innerHeight;
    ctx.camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    ctx.pipeline?.resize(innerWidth, innerHeight);
  });
}

function applyQuality() {
  const q = QUALITY[ctx.quality];
  const { renderer, camera, env } = ctx;
  renderer.setPixelRatio(q.pr);
  renderer.shadowMap.enabled = q.shadows;
  env.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
  if (env.sun.shadow.map) {
    env.sun.shadow.map.dispose();
    env.sun.shadow.map = null;
  }
  camera.far = q.far;
  camera.updateProjectionMatrix();
  env.setLampLightCount(q.lampLights);
  ctx.scene.traverse((o) => {
    if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true;
  });
}

/** Places the player near the Main Tower with a taxi and a coupé at the kerb. */
function createSpawn() {
  const mt = ctx.city.names.find((n) => n.name === 'Main Tower') || { x: -128, z: -136 };
  let best = null,
    bd = Infinity;
  for (const e of ctx.roads.edges) {
    if (e.width < 8) continue;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const a = e.pts[i],
        b = e.pts[i + 1];
      const mx = (a[0] + b[0]) / 2,
        mz = (a[1] + b[1]) / 2;
      const d = Math.hypot(mx - mt.x, mz - mt.z);
      if (d > 35 && d < bd && Math.hypot(b[0] - a[0], b[1] - a[1]) > 12) {
        bd = d;
        best = { x: mx, z: mz, yaw: Math.atan2(b[0] - a[0], b[1] - a[1]), w: e.width };
      }
    }
  }
  const sp = best || { x: mt.x, z: mt.z, yaw: 0, w: 8 };
  const off = sp.w / 2 + 2.5;
  ctx.spawn = { x: sp.x + Math.cos(sp.yaw) * off, z: sp.z - Math.sin(sp.yaw) * off, yaw: sp.yaw };
  ctx.focus = { x: mt.x, z: mt.z };
  const kerb = sp.w / 2 - 1.2;
  const cx = sp.x + Math.cos(sp.yaw) * kerb,
    cz = sp.z - Math.sin(sp.yaw) * kerb;
  ctx.vehicles.spawn('taxi', cx, cz, sp.yaw, 'parked', { driver: false });
  ctx.vehicles.spawn('coupe', cx + Math.sin(sp.yaw) * 7, cz + Math.cos(sp.yaw) * 7, sp.yaw, 'parked', { driver: false });
  // parked cars along quieter streets
  const quiet = ctx.roads.edges.filter((e) => e.speed <= 9 && e.len > 50);
  for (let i = 0; i < 24 && quiet.length; i++) {
    const e = rnd.pick(quiet);
    const j = Math.floor(rnd() * (e.pts.length - 1));
    const a = e.pts[j];
    const p = parkingSpot(a[0], a[1]);
    if (ctx.riverRings.some((r) => pip(p.x, p.z, r)) || ctx.traffic.occupied(p.x, p.z, 6)) continue;
    ctx.vehicles.spawn(pickKind(['police']), p.x, p.z, p.yaw, 'parked', { driver: false });
  }
}

async function boot() {
  const loading = new LoadingScreen();
  const stage = (p, text) => loading.progress(p, text);
  try {
    if (!settings.get('quality')) settings.set('quality', 'auto');
    ctx.uniforms = uniforms;
    ctx.districts = DISTRICTS;
    setupRenderer();

    stage(0.04, 'Starting physics engine');
    await RAPIER.init();
    ctx.RAPIER = RAPIER;

    stage(0.1, 'Loading 3D models');
    ctx.models = await loadModels((p) => stage(0.1 + p * 0.12));

    stage(0.2, 'Loading assets');
    await assets.runPreloads((p) => stage(0.2 + p * 0.04, 'Loading assets'));

    stage(0.24, 'Unpacking OpenStreetMap data');
    ctx.city = await loadCity();
    ctx.streets = await loadStreets();
    await yieldFrame();

    stage(0.32, `Building ${ctx.city.buildings.length.toLocaleString('en')} buildings and ${ctx.city.roads.length.toLocaleString('en')} streets`);
    await yieldFrame();
    const cityResult = buildCity(ctx.city);
    ctx.streetIndex = cityResult.streetIndex;
    ctx.landmarks = cityResult.landmarks;

    stage(0.55, 'Sky, weather and lighting');
    await yieldFrame();
    ctx.env = new Environment();
    ctx.env.build();

    stage(0.62, 'Creating the physics world');
    await yieldFrame();
    ctx.physics = new Physics();
    ctx.physics.build(cityResult);
    ctx.furniture = new Furniture();
    ctx.furniture.build();

    stage(0.72, 'Mapping the road network');
    await yieldFrame();
    const ways = ctx.city.roads
      .filter((r) => r.pts.length >= 2 && isCarRoad(r))
      .map((r) => ({ pts: r.pts, oneway: r.oneway, speed: RC[r.c][2], width: roadWidth(r), name: r.name }));
    ctx.roads = new RoadNetwork(ways);

    stage(0.78, 'Populating the city');
    await yieldFrame();
    ctx.stats = new Stats();
    ctx.blips = new Blips();
    ctx.markers = new Markers();
    ctx.vehicles = new VehicleManager();
    ctx.traffic = new Traffic();
    ctx.peds = new Pedestrians();
    ctx.peds.build();
    ctx.player = new Player();
    ctx.police = new Police();
    ctx.wanted = new WantedSystem(undefined, (t, p) => events.emit(t, p));
    ctx.cameraRig = new CameraRig();
    ctx.audio = new AudioManager();
    ctx.game = new Game();
    ctx.game.wireEvents();
    createSpawn();
    ctx.player.create(ctx.spawn.x, ctx.spawn.z, ctx.spawn.yaw);
    ctx.cameraRig.yaw = ctx.spawn.yaw + Math.PI;
    ctx.vehicles.index();
    ctx.traffic.populate(ctx.spawn);
    ctx.peds.populate(ctx.spawn);

    stage(0.88, 'Drawing the map');
    await yieldFrame();
    const mapRenderer = new MapRenderer(ctx.city);
    ctx.map = new MapScreen(mapRenderer);
    ctx.gps = new Gps();
    ctx.services = new Services();
    ctx.services.build();
    ctx.missions = new MissionRunner();
    ctx.missions.setupWorld();
    ctx.hud = new Hud();
    ctx.hud.minimap = new Minimap(document.getElementById('minimap'), mapRenderer);
    ctx.menus = new Menus();

    stage(0.9, 'Loading textures');
    await assets.ready((p) => stage(0.9 + p * 0.05, 'Loading textures'));

    stage(0.96, 'Compiling shaders');
    await yieldFrame();
    ctx.pipeline = new RenderPipeline(ctx.renderer, ctx.scene, ctx.camera);
    ctx.renderer.compile(ctx.scene, ctx.camera);
    input.attach(ctx.renderer.domElement);
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) input.setupTouch(document.getElementById('touch'));
    events.on('settings:changed', ({ key, value }) => {
      if (key === 'quality') {
        ctx.quality = resolveQuality(value, ctx.renderer);
        applyQuality();
      }
    });
    ctx.env.startWeatherUpdates();
    startLoop();
    loading.hide();
    showTitle();
  } catch (e) {
    console.error(e);
    loading.error(e.message || String(e));
  }
}

function showTitle() {
  ctx.game.state = 'title';
  ctx.menus.showTitle({
    onContinue: (data) => startPlaying(() => ctx.game.load(data)),
    onNew: () =>
      startPlaying(() => {
        ctx.game.newGame();
        setTimeout(
          () =>
            events.emit('help', {
              text: 'Welcome to Frankfurt. Find <b>Lena</b> at the yellow <b>L</b> on your map (press <b>M</b>) to start your first job. Press <b>F</b> next to a car to get in.',
              ms: 9000,
            }),
          1200,
        );
      }),
    onLoad: (data) => startPlaying(() => ctx.game.load(data)),
  });
}

function startPlaying(setup) {
  ctx.audio.init();
  ctx.menus.hideTitle();
  ctx.hud.fade(true);
  setTimeout(() => {
    setup();
    ctx.game.state = 'playing';
    ctx.hud.show(true);
    input.enabled = true;
    if (!input.isTouch) input.lockPointer();
    ctx.hud.fade(false);
  }, 500);
}

/** One frame of game logic; render=false lets tests advance the simulation quickly. */
function frame(raw, render = true) {
  const { camera } = ctx;
  uniforms.uTime.value += raw;
  input.pollGamepad(raw);
  const game = ctx.game;
  const player = ctx.player;
  if (game.state === 'title') {
    ctx.cameraRig.intro(uniforms.uTime.value, ctx.focus);
    ctx.vehicles.sync(raw, camera.position, uniforms.uNight.value, null);
    ctx.env.update(raw, ctx.focus);
  } else {
    if (game.state === 'playing') game.handleActions();
    if (!game.paused) {
      const dt = raw * ctx.timeScale;
      game.simulate(dt);
      ctx.vehicles.index();
      player.update(dt);
      ctx.peds.update(dt, player.position);
      ctx.police.update(dt);
      ctx.furniture.update(dt, ctx.vehicles.list);
      ctx.wanted.update(dt, ctx.police.seesPlayer);
      ctx.missions.update(dt);
      ctx.markers.update(dt);
      ctx.services.update(dt);
      ctx.gps.update(dt);
      ctx.stats.add('playTime', raw);
      ctx.cameraRig.update(raw);
      player.ch.root.visible = !(player.vehicle && ctx.cameraRig.carMode === 3);
      ctx.vehicles.sync(dt, camera.position, uniforms.uNight.value, player.vehicle);
      ctx.hud.update(raw);
      ctx.env.update(raw, player.position);
    } else ctx.env.update(0, player.position);
    ctx.audio.update(raw);
  }
  ctx.furniture.cull(camera.position);
  if (render) {
    ctx.pipeline.update(raw);
    ctx.pipeline.render();
  }
  input.endFrame();
}

function startLoop() {
  const clock = new THREE.Clock();
  let fpsT = 0,
    frames = 0;
  ctx.renderer.setAnimationLoop(() => {
    const raw = Math.min(clock.getDelta(), 0.1);
    frame(raw);
    frames++;
    fpsT += raw;
    if (fpsT > 1) {
      ctx.fps = frames / fpsT;
      frames = fpsT = 0;
    }
  });
  // test/debug hook (used by tests/smoke.mjs): advance(seconds) runs game logic without rendering
  window.__game = {
    ctx,
    input,
    events,
    settings,
    advance(seconds, step = 1 / 30) {
      for (let t = 0; t < seconds; t += step) frame(step, false);
    },
  };
}

boot();
