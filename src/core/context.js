/**
 * Shared runtime context. Systems are created once at boot and registered here so
 * modules can reach each other without circular imports or globals on window.
 */
export const ctx = {
  /** @type {import('three').WebGLRenderer} */ renderer: null,
  /** @type {import('three').Scene} */ scene: null,
  /** @type {import('three').PerspectiveCamera} */ camera: null,
  /** Rapier world */ world: null,
  RAPIER: null,
  /** Decoded OSM city data */ city: null,
  /** Precomputed street geometry */ streets: null,
  /** Parsed GLTF models by name */ models: {},
  /** Road network (graph for AI + GPS) */ roads: null,
  /** Shader uniforms shared by world materials */ uniforms: null,
  /** Shared materials by name */ mats: {},
  quality: 'medium',
  spawn: { x: 0, z: 0, yaw: 0 },
  /** River polygons (for swimming/sinking). */ riverRings: [],
  player: null,
  vehicles: null,
  traffic: null,
  peds: null,
  police: null,
  wanted: null,
  missions: null,
  env: null,
  audio: null,
  hud: null,
  map: null,
  game: null,
  /** Real elapsed simulation time (s), pauses with the game. */ simTime: 0,
  timeScale: 1,
};
