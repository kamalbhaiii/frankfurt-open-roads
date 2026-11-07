/**
 * Heat (wanted level) logic: crimes add heat points, points map to levels 0–5.
 * When no police unit can see the player for the level's cooldown, the heat is lost.
 * Pure logic (no rendering); unit-tested in tests/wanted.test.mjs.
 */
import { WANTED } from '../core/config.js';

/** Heat points per crime type: [base, extra when police witness it]. */
export const CRIMES = {
  carjack: [10, 35],
  hitPed: [14, 30],
  stealPolice: [45, 45],
  hitPolice: [40, 0],
  evadeArrest: [0, 0],
};

export class WantedSystem {
  constructor(cfg = WANTED, emit = () => {}) {
    this.cfg = cfg;
    this.emit = emit;
    this.points = 0;
    this.level = 0;
    this.unseen = 0;
    this.searching = false;
  }

  levelFor(points) {
    let l = 0;
    for (let i = 1; i < this.cfg.thresholds.length; i++) if (points >= this.cfg.thresholds[i]) l = i;
    return l;
  }

  /** Adds heat. `witnessedByPolice` adds the crime's police bonus. */
  report(type, { witnessedByPolice = false, witnesses = 0 } = {}) {
    const c = CRIMES[type];
    if (!c) return this.level;
    let pts = c[0] + (witnessedByPolice ? c[1] : 0);
    // nobody saw an unwitnessed carjacking: no heat
    if (type === 'carjack' && !witnessedByPolice && witnesses === 0) pts = 0;
    if (pts <= 0) return this.level;
    this.add(pts);
    return this.level;
  }

  add(points) {
    const prev = this.level;
    this.points = Math.min(this.points + points, this.cfg.thresholds[this.cfg.thresholds.length - 1] + 50);
    this.level = Math.max(this.level, this.levelFor(this.points));
    this.unseen = 0;
    this.searching = false;
    if (this.level !== prev) this.emit('wanted:changed', { level: this.level, prev });
  }

  /** Guarantees at least the given level (missions, stealing a police car). */
  setMinLevel(level) {
    if (level <= this.level) return;
    this.add(Math.max(0, this.cfg.thresholds[level] - this.points));
  }

  clear() {
    const prev = this.level;
    this.points = 0;
    this.level = 0;
    this.unseen = 0;
    this.searching = false;
    if (prev) this.emit('wanted:changed', { level: 0, prev });
  }

  /** @param seen true when any police unit currently sees the player */
  update(dt, seen) {
    if (!this.level) return;
    if (seen) {
      this.unseen = 0;
      this.searching = false;
      return;
    }
    this.unseen += dt;
    this.searching = this.unseen > 2;
    if (this.unseen >= this.cfg.cooldown[this.level]) this.clear();
  }

  get searchRadius() {
    return this.cfg.searchRadius[this.level];
  }
  get desiredUnits() {
    return this.cfg.units[this.level];
  }
  /** Seconds remaining until the heat is lost (only while searching). */
  get timeToLose() {
    return this.level ? Math.max(0, this.cfg.cooldown[this.level] - this.unseen) : 0;
  }
}
