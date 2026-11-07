/**
 * In-game HUD: money, heat, clock, health/armour, minimap, area/vehicle/radio
 * popups, speedometer, help box, objective, subtitles, banners and death screen.
 */
import { ctx } from '../core/context.js';
import { events } from '../core/events.js';
import { settings } from '../core/settings.js';
import { formatMoney, formatClock } from '../core/math.js';
import { MAX_HEALTH } from '../actors/vehicles.js';

const $ = (id) => document.getElementById(id);
const STAR = '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3 6.1 20.6l1.3-6.6L2.5 9.4l6.6-.8z" stroke-width="1.4"/></svg>';

export class Hud {
  constructor() {
    this.el = $('hud');
    this.e = {};
    for (const id of [
      'clock',
      'weather',
      'money',
      'money-delta',
      'wanted',
      'timer',
      'hp',
      'ar',
      'gps',
      'radio',
      'vehicle',
      'speed',
      'carhp',
      'area',
      'district',
      'street',
      'help',
      'objective',
      'subtitle',
      'prompt',
      'note',
      'arrest',
      'big',
    ])
      this.e[id] = $(`hud-${id}`);
    this.e.wanted.innerHTML = Array.from({ length: 5 }, () => `<span class="off">${STAR}</span>`).join('');
    this.stars = [...this.e.wanted.children];
    this.timers = {};
    this.shownMoney = null;
    this.lastDistrict = '';
    this.lastStreet = '';
    this.hudT = 0;
    this.fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
    this.fmtDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', day: 'numeric', month: 'short' });
    this.bind();
  }

  bind() {
    events.on('notify', ({ text, ms = 1800 }) => this.flash('note', text, ms));
    events.on('help', ({ text, ms = 5000 }) => {
      if (settings.get('showHelp')) this.flash('help', text, ms);
    });
    events.on('subtitle', ({ text, ms = 4500 }) => this.flash('subtitle', text, ms));
    events.on('objective', ({ text }) => {
      this.e.objective.textContent = text;
      this.e.objective.classList.toggle('hidden', !text);
      if (text) this.flash('subtitle', text, 4000);
    });
    events.on('bigtext', ({ text, sub = '', ms = 2500, fail = false }) => this.big(text, sub, ms, fail));
    events.on('mission:passed', ({ mission, reward, text }) =>
      this.big(mission.type === 'race' ? 'RACE COMPLETE' : 'MISSION PASSED', [text, reward ? formatMoney(reward) : ''].filter(Boolean).join(' · '), 4500),
    );
    events.on('mission:failed', ({ reason }) => this.big('MISSION FAILED', reason, 4500, true));
    events.on('mission:start', ({ mission }) => this.big(mission.title.toUpperCase(), mission.type === 'job' ? 'Press J to stop the job' : '', 2600));
    events.on('mission:ended', ({ text, reason }) => this.big('JOB OVER', [reason, text].filter(Boolean).join(' · '), 4000));
    events.on('vehicle:enter', ({ car }) => {
      this.flash('vehicle', car.label, 2500);
      const r = ctx.audio.radio;
      if (r && r.station.id !== 'off') this.showRadio(r.station);
    });
    events.on('radio:changed', ({ station }) => this.showRadio(station));
    events.on('money', ({ amount }) => {
      const d = this.e['money-delta'];
      d.textContent = `${amount > 0 ? '+' : '−'}${formatMoney(Math.abs(amount))}`;
      d.className = amount > 0 ? 'pos' : 'neg';
      d.style.opacity = 1;
      clearTimeout(this.timers.delta);
      this.timers.delta = setTimeout(() => (d.style.opacity = 0), 2200);
    });
    events.on('player:damage', () => {
      this.el.animate([{ boxShadow: 'inset 0 0 120px rgba(229,72,77,0.7)' }, { boxShadow: 'inset 0 0 0 rgba(229,72,77,0)' }], { duration: 500 });
    });
  }

  showRadio(station) {
    this.e.radio.innerHTML = `${station.name}${station.genre ? `<small>${station.genre}</small>` : ''}`;
    this.flash('radio', null, 2500);
  }

  /** Shows a popup element for ms milliseconds. */
  flash(id, text, ms) {
    const el = this.e[id];
    if (text != null) el.innerHTML = text;
    el.classList.add('show');
    clearTimeout(this.timers[id]);
    this.timers[id] = setTimeout(() => el.classList.remove('show'), ms);
  }

  big(title, sub, ms, fail = false) {
    const el = this.e.big;
    el.innerHTML = `<div class="big-title${fail ? ' fail' : ''}">${title}</div>${sub ? `<div class="big-sub shadow">${sub}</div>` : ''}`;
    el.classList.remove('hidden', 'show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this.timers.big);
    this.timers.big = setTimeout(() => el.classList.add('hidden'), ms);
  }

  show(on) {
    this.el.classList.toggle('off', !on);
  }

  showDeath(title) {
    $('death-title').textContent = title;
    $('death').classList.add('show');
    this.show(false);
  }
  hideDeath() {
    $('death').classList.remove('show');
    this.show(true);
  }
  fade(on) {
    $('fade').classList.toggle('on', on);
  }

  update(dt) {
    const player = ctx.player;
    const e = this.e;
    // money counts towards the real value
    if (this.shownMoney == null) this.shownMoney = player.money;
    this.shownMoney += (player.money - this.shownMoney) * Math.min(1, dt * 6);
    if (Math.abs(player.money - this.shownMoney) < 1) this.shownMoney = player.money;
    e.money.textContent = formatMoney(this.shownMoney);

    // heat stars
    const w = ctx.wanted;
    this.stars.forEach((s, i) => (s.className = i < w.level ? 'on' : 'off'));
    e.wanted.classList.toggle('flash', w.level > 0 && w.searching);
    e.wanted.style.visibility = w.level > 0 ? 'visible' : 'hidden';

    // health/armour
    e.hp.firstElementChild.style.width = `${player.health}%`;
    e.hp.classList.toggle('low', player.health < 25);
    e.ar.firstElementChild.style.width = `${player.armor}%`;
    e.ar.classList.toggle('empty', player.armor <= 0);

    // mission timer
    const t = ctx.missions.timer;
    e.timer.classList.toggle('hidden', t == null);
    if (t != null) {
      e.timer.innerHTML = `<small>TIME</small>${formatClock(t)}`;
      e.timer.classList.toggle('low', t < 15);
    }

    // vehicle
    const car = player.vehicle;
    e.speed.classList.toggle('hidden', !car);
    e.carhp.classList.toggle('hidden', !car);
    if (car) {
      const mph = settings.get('units') === 'mph';
      const v = Math.abs(Math.round((car.kmh || 0) * (mph ? 0.621 : 1)));
      e.speed.innerHTML = `${v}<small>${mph ? 'mph' : 'km/h'}</small>`;
      e.carhp.firstElementChild.style.width = `${(car.health / MAX_HEALTH) * 100}%`;
    }

    // arrest meter
    const ap = ctx.police.arrestProgress;
    e.arrest.classList.toggle('hidden', ap <= 0.05);
    if (ap > 0.05) e.arrest.querySelector('i').style.width = `${Math.min(1, ap / (player.vehicle ? 3 : 1.4)) * 100}%`;

    // interaction prompt
    const prompt = player.prompt;
    e.prompt.classList.toggle('show', !!prompt && !ctx.game.controlsLocked);
    if (prompt) e.prompt.textContent = prompt;

    // GPS distance
    const gps = ctx.gps;
    e.gps.textContent = gps.target
      ? `${gps.target.label} · ${gps.distance >= 1000 ? `${(gps.distance / 1000).toFixed(1)} km` : `${Math.round(gps.distance / 10) * 10} m`}`
      : '';

    // slower updates: clock, weather, location
    this.hudT -= dt;
    if (this.hudT <= 0) {
      this.hudT = 0.4;
      const env = ctx.env;
      const date = env.date;
      e.clock.textContent = this.fmtTime.format(date);
      const wx = env.weather;
      e.weather.textContent = `${this.fmtDate.format(date)} · ${wx.label} · ${Math.round(wx.temp ?? 0)}°C`;
      const P = player.position;
      const district = ctx.game.district(P);
      const street = ctx.streetIndex.nearest(P.x, P.z) || '';
      if (district !== this.lastDistrict || (street && street !== this.lastStreet)) {
        e.district.textContent = district;
        e.street.textContent = street;
        this.flash('area', null, district !== this.lastDistrict ? 4500 : 2500);
        this.lastDistrict = district;
        if (street) this.lastStreet = street;
      }
    }
    this.minimap?.draw();
  }
}
