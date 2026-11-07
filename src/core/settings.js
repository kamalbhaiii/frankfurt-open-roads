/**
 * Player settings with defaults, persistence and change notifications.
 */
import { STORAGE_KEYS } from './config.js';
import { storage } from './storage.js';
import { events } from './events.js';

/** Default key bindings: action -> [primary, secondary] KeyboardEvent.code values. */
export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space', ''],
  vehicle: ['KeyF', 'Enter'],
  horn: ['KeyH', ''],
  unstuck: ['KeyR', ''],
  camera: ['KeyV', ''],
  lookBehind: ['KeyC', ''],
  radio: ['KeyQ', ''],
  job: ['KeyJ', ''],
  map: ['KeyM', ''],
  timeSpeed: ['KeyT', ''],
  pause: ['Escape', 'KeyP'],
};

export const ACTION_LABELS = {
  forward: 'Forward / accelerate',
  back: 'Back / brake / reverse',
  left: 'Left / steer left',
  right: 'Right / steer right',
  sprint: 'Sprint',
  jump: 'Jump / handbrake',
  vehicle: 'Enter / exit vehicle',
  horn: 'Horn / siren',
  unstuck: 'Flip vehicle / unstuck',
  camera: 'Change camera',
  lookBehind: 'Look behind',
  radio: 'Next radio station',
  job: 'Start / stop vehicle job',
  map: 'Open map',
  timeSpeed: 'Change time speed',
  pause: 'Pause menu',
};

export const DEFAULT_SETTINGS = {
  // display
  quality: null, // chosen on first run from the device
  fov: 62,
  drawDistance: 1,
  minimapRotate: true,
  units: 'kmh',
  showHelp: true,
  // audio
  masterVolume: 0.8,
  sfxVolume: 0.9,
  radioVolume: 0.6,
  ambientVolume: 0.7,
  // controls
  mouseSensitivity: 1,
  invertY: false,
  autoCenterCamera: true,
  bindings: DEFAULT_BINDINGS,
  // world
  weatherMode: 'live',
  timeMode: 'real',
  trafficDensity: 1,
  pedDensity: 1,
};

class Settings {
  constructor() {
    const saved = storage.get(STORAGE_KEYS.settings, {});
    this.values = { ...DEFAULT_SETTINGS, ...saved, bindings: { ...DEFAULT_BINDINGS, ...(saved.bindings || {}) } };
  }
  get(key) {
    return this.values[key];
  }
  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.persist();
    events.emit('settings:changed', { key, value });
  }
  bind(action, slot, code) {
    const b = { ...this.values.bindings };
    // a key can only drive one action: clear it elsewhere
    for (const a in b) b[a] = b[a].map((c) => (c === code ? '' : c));
    b[action] = b[action].slice();
    b[action][slot] = code;
    this.values.bindings = b;
    this.persist();
    events.emit('settings:changed', { key: 'bindings', value: b });
  }
  resetBindings() {
    this.values.bindings = { ...DEFAULT_BINDINGS };
    this.persist();
    events.emit('settings:changed', { key: 'bindings', value: this.values.bindings });
  }
  persist() {
    storage.set(STORAGE_KEYS.settings, this.values);
  }
}

export const settings = new Settings();

/** Human readable name for a KeyboardEvent.code. */
export function keyName(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    ShiftLeft: 'L-Shift',
    ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl',
    ControlRight: 'R-Ctrl',
    Space: 'Space',
    Escape: 'Esc',
    Enter: 'Enter',
    Tab: 'Tab',
    AltLeft: 'L-Alt',
  };
  return map[code] || code;
}
