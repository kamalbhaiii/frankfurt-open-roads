/**
 * Loads the embedded assets: gzipped OSM city data, precomputed streets and GLB models.
 * The bundler inlines .gz and .glb files as Uint8Array (see build.mjs).
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import CITY_GZ from '../../data/frankfurt_osm.json.gz';
import STREETS_GZ from '../../data/streets.json.gz';
import car_sedan from '../../assets/models/car_sedan.glb';
import car_taxi from '../../assets/models/car_taxi.glb';
import car_hatchback from '../../assets/models/car_hatchback.glb';
import car_estate from '../../assets/models/car_estate.glb';
import car_suv from '../../assets/models/car_suv.glb';
import car_coupe from '../../assets/models/car_coupe.glb';
import car_van from '../../assets/models/car_van.glb';
import car_police from '../../assets/models/car_police.glb';
import car_bus from '../../assets/models/car_bus.glb';
import car_ambulance from '../../assets/models/car_ambulance.glb';
import car_tow from '../../assets/models/car_tow.glb';
import car_scooter from '../../assets/models/car_scooter.glb';
import car_tram from '../../assets/models/car_tram.glb';
import car_bicycle from '../../assets/models/car_bicycle.glb';
import car_refuse from '../../assets/models/car_refuse.glb';
import character_male from '../../assets/models/character_male.glb';
import character_female from '../../assets/models/character_female.glb';
import prop_lamp from '../../assets/models/prop_lamp.glb';
import prop_traffic_light from '../../assets/models/prop_traffic_light.glb';
import prop_barrier from '../../assets/models/prop_barrier.glb';

const MODEL_FILES = {
  car_sedan,
  car_taxi,
  car_hatchback,
  car_estate,
  car_suv,
  car_coupe,
  car_van,
  car_police,
  car_bus,
  car_ambulance,
  car_tow,
  car_scooter,
  car_tram,
  car_bicycle,
  car_refuse,
  character_male,
  character_female,
  prop_lamp,
  prop_traffic_light,
  prop_barrier,
};

async function gunzipJSON(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

export async function loadModels(onProgress) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const out = {};
  const entries = Object.entries(MODEL_FILES);
  let done = 0;
  await Promise.all(
    entries.map(
      ([name, u8]) =>
        new Promise((resolve, reject) => {
          const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
          loader.parse(
            buf,
            '',
            (gltf) => {
              out[name] = gltf;
              onProgress?.(++done / entries.length);
              resolve();
            },
            reject,
          );
        }),
    ),
  );
  return out;
}

/** Decodes the compact delta-encoded OSM extract into plain polylines/polygons. */
export async function loadCity() {
  const d = await gunzipJSON(CITY_GZ);
  const dec = (a, s) => {
    const pts = [];
    let x = 0,
      z = 0;
    for (let i = s; i < a.length; i += 2) {
      x += a[i];
      z += a[i + 1];
      pts.push([x / 2, z / 2]);
    }
    return pts;
  };
  const clean = (pts) => {
    const o = [];
    for (const p of pts) {
      const l = o[o.length - 1];
      if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.3) o.push(p);
    }
    return o;
  };
  return {
    pal: d.pal,
    buildings: d.b.map((a) => ({ h: a[0], mh: a[1], col: a[2], pts: clean(dec(a, 3)) })),
    roads: d.r.map((a) => ({ c: a[0], name: a[1] >= 0 ? d.rn[a[1]] : '', bridge: a[2], lanes: a[3], oneway: a[4], pts: clean(dec(a, 5)) })),
    water: d.w.map((a) => clean(dec(a, 0))),
    parks: d.p.map((a) => clean(dec(a, 0))),
    rails: d.rl.map((a) => ({ tram: a[0], bridge: a[1], pts: clean(dec(a, 2)) })),
    names: d.n.map((n) => ({ x: n[0] / 2, z: n[1] / 2, h: n[2], name: n[3] })),
  };
}

export const loadStreets = () => gunzipJSON(STREETS_GZ);
