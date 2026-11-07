/**
 * Runtime asset loading for files shipped in public/ (copied next to index.html).
 * Every request is tracked so the loading screen can wait for them: assets.ready().
 *
 *   const tex = assets.texture('textures/streets/asphalt_color.jpg', { srgb: true, repeat: [4, 4] });
 *   const gltf = await assets.gltf('models/vehicles/bus.glb');
 *
 * Compress models with Meshopt (gltf-transform), not Draco.
 * Missing files never crash the game: a neutral placeholder is used and a warning logged.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

class Assets {
  constructor() {
    this.cache = new Map();
    this.pending = new Set();
    this.total = 0;
    this.done = 0;
    this.texLoader = new THREE.TextureLoader();
    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);
    this.maxAnisotropy = 8;
  }

  track(promise) {
    this.total++;
    this.pending.add(promise);
    promise.finally(() => {
      this.pending.delete(promise);
      this.done++;
    });
    return promise;
  }

  /**
   * Returns a texture immediately (filled in when loaded).
   * opts: srgb (colour data) | repeat: true or [u, v] | anisotropy (default max) | flipY
   */
  texture(url, opts = {}) {
    const key = `tex:${url}:${JSON.stringify(opts)}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const tex = new THREE.Texture();
    tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (opts.repeat) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      if (Array.isArray(opts.repeat)) tex.repeat.set(opts.repeat[0], opts.repeat[1]);
    }
    tex.anisotropy = opts.anisotropy ?? this.maxAnisotropy;
    if (opts.flipY != null) tex.flipY = opts.flipY;
    this.cache.set(key, tex);
    this.track(
      new Promise((resolve) => {
        this.texLoader.load(
          url,
          (loaded) => {
            tex.image = loaded.image;
            tex.needsUpdate = true;
            resolve(tex);
          },
          undefined,
          () => {
            console.warn(`[assets] missing texture ${url}`);
            resolve(tex);
          },
        );
      }),
    );
    return tex;
  }

  /** Loads a glTF/GLB; resolves to the parsed gltf (null if missing). */
  gltf(url) {
    const key = `gltf:${url}`;
    if (!this.cache.has(key)) {
      this.cache.set(
        key,
        this.track(
          this.gltfLoader.loadAsync(url).catch((e) => {
            console.warn(`[assets] missing model ${url}`, e?.message || e);
            return null;
          }),
        ),
      );
    }
    return this.cache.get(key);
  }

  /** Equirectangular HDR environment (for reflections/sky lighting). */
  hdr(url) {
    const key = `hdr:${url}`;
    if (!this.cache.has(key)) {
      this.cache.set(
        key,
        this.track(
          new RGBELoader().loadAsync(url).then(
            (t) => {
              t.mapping = THREE.EquirectangularReflectionMapping;
              return t;
            },
            () => {
              console.warn(`[assets] missing HDR ${url}`);
              return null;
            },
          ),
        ),
      );
    }
    return this.cache.get(key);
  }

  /** Raw bytes (audio files, JSON …). */
  bytes(url) {
    const key = `bin:${url}`;
    if (!this.cache.has(key)) {
      this.cache.set(
        key,
        this.track(
          fetch(url).then(
            (r) => (r.ok ? r.arrayBuffer() : null),
            () => null,
          ),
        ),
      );
    }
    return this.cache.get(key);
  }

  /**
   * Registers an async loader that must finish before the world is built
   * (e.g. models a module needs synchronously later). Call at module load time.
   */
  preload(name, fn) {
    (this.preloaders ||= []).push({ name, fn });
  }

  /** Runs all registered preloaders (main.js calls this during the loading screen). */
  async runPreloads(onProgress) {
    const list = this.preloaders || [];
    let done = 0;
    await Promise.all(
      list.map(({ name, fn }) =>
        Promise.resolve()
          .then(fn)
          .catch((e) => console.warn(`[assets] preload ${name} failed`, e))
          .finally(() => onProgress?.(++done / list.length)),
      ),
    );
  }

  /** Resolves when everything requested so far has finished (loaded or failed). */
  async ready(onProgress) {
    while (this.pending.size) {
      onProgress?.(this.total ? this.done / this.total : 1);
      await Promise.race([...this.pending]);
    }
    onProgress?.(1);
  }
}

export const assets = new Assets();
