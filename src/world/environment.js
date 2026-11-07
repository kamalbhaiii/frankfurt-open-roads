/**
 * Time of day, sun/moon lighting (cascaded shadows), sky-driven image-based lighting,
 * weather blending, fog, street-lamp lights and lightning.
 * OWNER: lighting/rendering agent.
 */
import * as THREE from 'three';
import * as SunCalc from 'suncalc';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { ctx } from '../core/context.js';
import { LAT, LON, QUALITY } from '../core/config.js';
import { clamp, hash, lerp, smooth } from '../core/math.js';
import { settings } from '../core/settings.js';
import { events } from '../core/events.js';
import { uniforms } from './materials.js';
import { SkySystem, buildPrecipitation } from './sky.js';
import { updateWater } from './water.js';
import { PRESETS, fetchLiveWeather } from './weather.js';

/** Time modes: id -> [scale, label]. 'real' follows the wall clock in Frankfurt. */
export const TIME_MODES = {
  real: [1, 'Real Frankfurt time'],
  normal: [1, 'Normal speed (×1)'],
  fast: [60, '×60 · 1 min = 1 h'],
  faster: [600, '×600'],
  frozen: [0, 'Frozen'],
};

const D2R = Math.PI / 180;
const dirOf = (altD, azD, out) => {
  const alt = altD * D2R,
    az = azD * D2R;
  return out.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
};
/** Street lamps in Frankfurt: mostly neutral LED now, some warm sodium left in side streets. */
const LED = new THREE.Color(1.0, 0.86, 0.7);
const SODIUM = new THREE.Color(1.0, 0.62, 0.3);

export class Environment {
  constructor() {
    this.gameTime = Date.now();
    this.weather = { cloud: 0.3, rain: 0, snow: 0, fog: 0.1, wind: 3, windDir: 240, temp: 10, storm: 0, label: 'Loading…', source: '' };
    this.live = null;
    this.wet = 0;
    this.snowCover = 0;
    this.flash = 0;
    this.nextFlash = 5;
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.lightDir = new THREE.Vector3(0, 1, 0);
    this.fogColor = new THREE.Color();
    this.windVec = new THREE.Vector2();
    this.dayFactor = 1;
    this.night = 0;
    /** Colours from the atmosphere model (linear). */
    this.sky = null;
    this.atmo = { horizon: new THREE.Color(), zenith: new THREE.Color(), sun: new THREE.Color() };
    /** Sun-tinted in-scatter colour for the post-processing aerial perspective. */
    this.hazeColor = new THREE.Color();
    this.colorT = 1;
    this.envT = 0;
    this.envKey = null;
  }

  build() {
    const { scene, renderer } = ctx;
    scene.fog = new THREE.FogExp2(0xa0b0c0, 0.0005);
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a4238, 0.6);
    scene.add(this.hemi);
    // SunLight: directional light with two cascaded shadow maps fitted to the view frustum
    const sun = (this.sun = new SunLight(0xffffff, 3));
    sun.name = 'sun';
    scene.add(sun);
    this.applyQuality();
    this.sky = new SkySystem();
    this.precip = buildPrecipitation();
    this.pmrem = new THREE.PMREMGenerator(renderer);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  /** (Re)applies the tier's shadow and lamp settings; also called when the tier changes. */
  applyQuality() {
    const q = QUALITY[ctx.quality];
    this.tier = ctx.quality;
    const sh = this.sun.shadow;
    sh.mapSize.set(q.shadowSize, q.shadowSize);
    sh.camera.near = 1;
    sh.camera.far = q.shadowDistance || 150;
    sh.camera.updateProjectionMatrix();
    sh.bias = -0.0002;
    sh.normalBias = 0.06;
    sh.radius = q.shadowRadius ?? 2;
    this.shadowScale = 1;
    this.setLampLightCount(q.lampLights);
    this.envT = 0;
  }

  /** Lets the render pipeline shorten the shadow range when the frame rate drops. */
  setShadowScale(s) {
    this.shadowScale = s;
    const sh = this.sun.shadow;
    sh.camera.far = (QUALITY[ctx.quality].shadowDistance || 150) * s;
  }

  setLampLightCount(n) {
    for (const l of this.lampLights || []) ctx.scene.remove(l);
    this.lampLights = [];
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffc98a, 0, 34, 2);
      ctx.scene.add(l);
      this.lampLights.push(l);
    }
  }

  async refreshWeather() {
    this.live = await fetchLiveWeather();
    if (!this.started) {
      Object.assign(this.weather, this.live);
      this.started = true;
    }
  }

  startWeatherUpdates() {
    this.refreshWeather();
    setInterval(() => this.refreshWeather(), 10 * 60 * 1000);
  }

  get timeMode() {
    return settings.get('timeMode');
  }
  setTimeMode(mode) {
    settings.set('timeMode', mode);
    if (mode === 'real') this.gameTime = Date.now();
    events.emit('notify', { text: TIME_MODES[mode][1] });
  }
  cycleTimeMode() {
    const order = ['real', 'fast', 'faster', 'frozen', 'normal'];
    this.setTimeMode(order[(order.indexOf(this.timeMode) + 1) % order.length]);
  }
  /** Jumps the clock to a given hour of the Frankfurt day. */
  setHour(hour) {
    const parts = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(
      new Date(this.gameTime),
    );
    const curH = +parts.find((p) => p.type === 'hour').value,
      curM = +parts.find((p) => p.type === 'minute').value;
    this.gameTime += ((hour - curH) * 60 - curM) * 60000;
    if (this.timeMode === 'real') settings.set('timeMode', 'normal');
    this.colorT = 1;
    this.envT = 0;
  }
  /** Advances the clock (used by the safehouse "sleep" and hospital/arrest). */
  advanceHours(h) {
    this.gameTime += h * 3600000;
    if (this.timeMode === 'real') settings.set('timeMode', 'normal');
    this.colorT = 1;
    this.envT = 0;
  }
  get date() {
    return new Date(this.gameTime);
  }

  targetWeather() {
    const mode = settings.get('weatherMode');
    if (mode === 'live') return this.live || PRESETS.cloudy;
    return { ...PRESETS[mode], temp: this.live?.temp ?? 10, windDir: 240, source: 'Manual weather' };
  }

  /** Haze (aerosol) amount for the atmosphere model: humid, foggy or overcast air scatters more. */
  get haze() {
    const w = this.weather;
    return 0.9 + w.fog * 1.6 + w.cloud * 0.6 + w.rain * 0.6;
  }

  /** Re-renders the sky into the PMREM environment map now and then (image-based lighting). */
  updateEnvironment(dt) {
    const q = QUALITY[ctx.quality];
    this.envT -= dt;
    const w = this.weather;
    const key = [this.sunDir.y, this.sunDir.x, this.sunDir.z, w.cloud, w.fog, w.rain, this.night];
    const prev = this.envKey;
    const changed =
      !prev ||
      Math.abs(key[0] - prev[0]) + Math.abs(key[1] - prev[1]) + Math.abs(key[2] - prev[2]) > 0.06 ||
      Math.abs(key[3] - prev[3]) + Math.abs(key[4] - prev[4]) + Math.abs(key[5] - prev[5]) > 0.12 ||
      Math.abs(key[6] - prev[6]) > 0.1;
    if (this.envT > 0 && !(changed && this.envT < q.envInterval - 1.5)) return;
    this.envT = q.envInterval;
    this.envKey = key;
    const rt = this.pmrem.fromScene(this.sky.envScene, 0, 0.1, 100, { size: q.envSize || 128 });
    const scene = ctx.scene;
    const old = this.envTarget;
    if (!old && scene.environment) scene.environment.dispose();
    scene.environment = rt.texture;
    this.envTarget = rt;
    old?.dispose();
  }

  /** Per-frame update. `focus` is the player position. */
  update(dt, focus) {
    const { scene, renderer, camera } = ctx;
    if (this.tier !== ctx.quality) this.applyQuality();
    const mode = this.timeMode;
    if (mode === 'real') this.gameTime = Date.now();
    else this.gameTime += dt * 1000 * (TIME_MODES[mode]?.[0] ?? 1);
    const date = this.date;
    const sp = SunCalc.getPosition(date, LAT, LON),
      mp = SunCalc.getMoonPosition(date, LAT, LON);
    // suncalc 2.x returns degrees, azimuth measured clockwise from north
    const sdir = dirOf(sp.altitude, sp.azimuth, this.sunDir);
    const mdir = dirOf(mp.altitude, mp.azimuth, this.moonDir);

    // weather blending
    const tw = this.targetWeather();
    const w = this.weather;
    const k = clamp(dt * 0.4, 0, 1);
    for (const key of ['cloud', 'rain', 'snow', 'fog', 'storm', 'wind']) w[key] = lerp(w[key], tw[key] ?? 0, k);
    w.temp = tw.temp;
    w.windDir = tw.windDir ?? 240;
    w.label = tw.label;
    w.source = tw.source;
    this.wet = clamp(this.wet + (w.rain > 0.2 ? dt * 0.05 : -dt * 0.01), 0, 1);
    this.snowCover = clamp(this.snowCover + (w.snow > 0.2 ? dt * 0.03 : -dt * 0.008), 0, 1);
    if (!['live', 'rain', 'storm'].includes(settings.get('weatherMode'))) this.wet = Math.min(this.wet, w.rain);
    uniforms.uWet.value = this.wet * 0.85;
    uniforms.uSnow.value = this.snowCover;

    const sa = sdir.y;
    const day = (this.dayFactor = smooth(-0.1, 0.25, sa));
    const night = (this.night = 1 - smooth(-0.06, 0.1, sa));
    uniforms.uNight.value = night;

    // atmosphere colours (CPU copy of the sky model), refreshed a few times per second
    const haze = this.haze;
    this.colorT += dt;
    if (this.colorT > 0.25 || dt === 0) {
      this.colorT = 0;
      this.sky.colors(sdir, haze, this.atmo);
    }
    const atmo = this.atmo;
    const overcast = clamp(w.cloud * 0.9 + w.rain * 0.3 + w.fog * 0.3, 0, 1);

    // sun / moon light: SunLight shines from its position towards the origin
    const sun = this.sun;
    const useSun = sa > -0.04;
    const lightDir = this.lightDir.copy(useSun ? sdir : mdir);
    if (lightDir.y < 0.06) lightDir.y = 0.06;
    lightDir.normalize();
    sun.position.copy(lightDir);
    sun.updateMatrixWorld();
    const cloudDim = 1 - overcast * 0.78;
    if (useSun) {
      const t = atmo.sun;
      const m = Math.max(t.r, t.g, t.b, 1e-4);
      sun.color.setRGB(t.r / m, t.g / m, t.b / m);
      sun.intensity = 2.5 * Math.pow(m, 0.7) * smooth(-0.04, 0.06, sa) * cloudDim;
    } else {
      sun.intensity = smooth(-0.1, 0.3, mdir.y) * 0.22 * (1 - w.cloud * 0.85);
      sun.color.setRGB(0.62, 0.72, 1.0);
    }
    sun.castShadow = QUALITY[ctx.quality].shadows && sun.intensity > 0.08;

    // sky light: hemisphere tinted by the sky model, greyer under cloud
    const hemi = this.hemi;
    const zl = Math.max(atmo.zenith.r, atmo.zenith.g, atmo.zenith.b, 1e-4);
    hemi.color.setRGB(atmo.zenith.r / zl, atmo.zenith.g / zl, atmo.zenith.b / zl).lerp(new THREE.Color(0.86, 0.9, 1), 0.45 + overcast * 0.4);
    hemi.intensity = lerp(0.05, 0.55, day) * (1 - overcast * 0.2) + night * 0.04;
    hemi.groundColor.setRGB(lerp(0.04, 0.33, day), lerp(0.04, 0.3, day), lerp(0.05, 0.27, day));

    // lightning
    this.flash = Math.max(0, this.flash - dt * 4);
    if (w.storm > 0.5) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.flash = 1;
        this.nextFlash = 4 + Math.random() * 10;
        setTimeout(() => ctx.audio?.thunder(), 600 + Math.random() * 2000);
      }
    }
    hemi.intensity += this.flash * 2.5;

    // fog: horizon colour of the atmosphere, greyed by cloud, with city glow at night
    const fogC = this.fogColor.copy(atmo.horizon);
    const lum = fogC.r * 0.3 + fogC.g * 0.55 + fogC.b * 0.15;
    const grey = lum * (1 - w.rain * 0.45) * (0.78 - w.fog * 0.08);
    fogC.lerp(new THREE.Color(grey * 0.93, grey * 0.97, grey * 1.04), clamp(overcast * 0.95, 0, 0.95));
    fogC.r += night * (0.012 + overcast * 0.02);
    fogC.g += night * (0.01 + overcast * 0.014);
    fogC.b += night * (0.012 + overcast * 0.008);
    scene.fog.color.copy(fogC);
    renderer.setClearColor(fogC);
    const dd = settings.get('drawDistance');
    const baseDens = (0.00024 + w.fog * 0.0035 + w.rain * 0.0009 + w.snow * 0.0016) / dd;
    scene.fog.density = lerp(scene.fog.density, baseDens, dt > 0 ? clamp(dt, 0, 1) : 1);
    // aerial perspective tint used by the post pipeline: sunlight scattered towards the viewer
    const sv = atmo.sun;
    this.hazeColor.setRGB(sv.r, sv.g * 0.92, sv.b * 0.8).multiplyScalar((1 - overcast * 0.85) * smooth(-0.03, 0.08, sa) * 0.9);

    // sky uniforms
    const sky = this.sky;
    sky.bake(renderer, sdir, haze);
    const su = sky.uniforms;
    su.sunDir.value.copy(sdir);
    su.moonDir.value.copy(mdir);
    su.sunTrans.value.copy(atmo.sun);
    su.cloud.value = w.cloud;
    su.rain.value = w.rain;
    su.fog.value = clamp(w.fog - 0.15, 0, 1) * 1.1;
    su.fogCol.value.copy(fogC);
    su.flash.value = this.flash * 0.6;
    su.night.value = night;
    su.cloudSun.value.copy(atmo.sun).multiplyScalar(3.2 * smooth(-0.04, 0.05, sa));
    su.cloudAmb.value.copy(atmo.zenith).multiplyScalar(1.1).lerp(fogC, 0.5);
    su.cloudAmb.value.r += night * 0.006;
    su.cloudAmb.value.g += night * 0.007;
    su.cloudAmb.value.b += night * 0.01;
    su.groundCol.value.copy(hemi.groundColor).multiplyScalar(hemi.intensity * 0.35 + sun.intensity * 0.08 * Math.max(lightDir.y, 0));
    const wr = ((w.windDir + 180) * Math.PI) / 180;
    this.windVec.set(-Math.sin(wr), Math.cos(wr)).multiplyScalar(w.wind);
    su.windOff.value.addScaledVector(this.windVec, dt * 0.0015);
    sky.update(camera);
    this.updateEnvironment(dt > 0 ? dt : 0);
    scene.environmentIntensity = 0.75 * (1 - overcast * 0.25);

    // precipitation lit by the sky (and lightning)
    for (const [o, amt] of [
      [this.precip.rain, w.rain],
      [this.precip.snow, w.snow],
    ]) {
      const u = o.material.uniforms;
      u.uCam.value.copy(camera.position);
      u.uWind.value.copy(this.windVec);
      u.uAmt.value = amt;
      u.uLight.value.copy(fogC).multiplyScalar(1.4).addScalar(0.03 + this.flash);
      o.visible = amt > 0.02;
    }

    // street lamps: emissive heads everywhere, real lights only on the nearest few
    const furn = ctx.furniture;
    if (furn?.lampMaterial) furn.lampMaterial.emissiveIntensity = night * 4;
    const near = [];
    if (furn && night > 0.05) {
      for (const L of furn.lampGrid.query(focus.x, focus.z, 110)) {
        if (L.fallen) continue;
        near.push([(L.x - focus.x) ** 2 + (L.z - focus.z) ** 2, L]);
      }
      near.sort((a, b) => a[0] - b[0]);
    }
    this.lampLights.forEach((l, i) => {
      const n = near[i];
      if (n) {
        const L = n[1];
        l.position.set(L.x + Math.sin(L.yaw) * 1.45, 7.6, L.z + Math.cos(L.yaw) * 1.45);
        l.color.copy(hash(Math.floor(L.x) * 0.37 + Math.floor(L.z) * 1.13) < 0.3 ? SODIUM : LED);
        // fade the farthest light in/out so lights don't pop when the set changes
        const fade = i === this.lampLights.length - 1 ? 0.5 : 1;
        l.intensity = night * 48 * fade;
      } else l.intensity = 0;
    });
    renderer.toneMappingExposure = lerp(1.15, 0.92, day) * (1 + overcast * 0.12 * day);
    updateWater(dt, this);
    ctx.audio?.setWeather(w);
  }
}
