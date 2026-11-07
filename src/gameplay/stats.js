/**
 * Career statistics shown in the pause menu and stored in save games.
 */
export const STAT_LABELS = {
  playTime: ['Time played', 'time'],
  missionsPassed: ['Story missions passed', 'int'],
  jobsDone: ['Jobs completed', 'int'],
  racesWon: ['Races won', 'int'],
  postcards: ['Postcards found', 'int'],
  moneyEarned: ['Money earned', 'money'],
  distanceWalked: ['Distance on foot', 'km'],
  distanceDriven: ['Distance driven', 'km'],
  topSpeed: ['Top speed', 'kmh'],
  carsStolen: ['Vehicles stolen', 'int'],
  pedsHit: ['Pedestrians knocked over', 'int'],
  crashes: ['Crashes', 'int'],
  maxWanted: ['Highest heat level', 'int'],
  timesBusted: ['Times arrested', 'int'],
  timesWasted: ['Times hospitalised', 'int'],
};

export class Stats {
  constructor(values = {}) {
    this.values = {};
    for (const k in STAT_LABELS) this.values[k] = values[k] ?? 0;
  }
  add(key, n) {
    this.values[key] = (this.values[key] || 0) + n;
  }
  max(key, n) {
    if (n > (this.values[key] || 0)) this.values[key] = n;
  }
  format(key) {
    const v = this.values[key] || 0;
    switch (STAT_LABELS[key][1]) {
      case 'time': {
        const h = Math.floor(v / 3600),
          m = Math.floor((v % 3600) / 60);
        return `${h}h ${String(m).padStart(2, '0')}m`;
      }
      case 'money':
        return `€${Math.round(v).toLocaleString('de-DE')}`;
      case 'km':
        return `${(v / 1000).toFixed(1)} km`;
      case 'kmh':
        return `${Math.round(v)} km/h`;
      default:
        return String(Math.round(v));
    }
  }
}
