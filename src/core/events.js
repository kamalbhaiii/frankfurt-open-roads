/**
 * Minimal synchronous event bus used to decouple gameplay systems from UI and audio.
 *
 * Events in use (payload):
 *   crime {type, severity, x, z}        money {amount, reason}
 *   player:damage {amount, source}      player:died {}            player:arrested {}
 *   vehicle:enter {car}                 vehicle:exit {car}        vehicle:crash {car, impact}
 *   mission:start {mission}             mission:passed {mission, reward}   mission:failed {mission, reason}
 *   wanted:changed {level, prev}        waypoint:changed {point|null}
 *   settings:changed {key, value}       notify {text, ms}         help {text, ms}
 */
export class EventBus {
  constructor() {
    this.handlers = new Map();
  }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) {
    this.handlers.get(type)?.delete(fn);
  }
  emit(type, payload = {}) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[events] handler for "${type}" failed`, e);
      }
    }
  }
}

export const events = new EventBus();
