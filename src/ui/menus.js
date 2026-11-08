/**
 * Title screen, pause menu (Map / Brief / Stats / Settings / Controls / Game tabs)
 * and modal dialogs (load, save, settings, controls, credits, confirm).
 * All menus support mouse, keyboard (arrows/Enter/Esc/Q/E) and touch.
 */
import { ctx } from '../core/context.js';
import { events } from '../core/events.js';
import { input } from '../core/input.js';
import { settings, ACTION_LABELS, keyName } from '../core/settings.js';
import { formatMoney } from '../core/math.js';
import { STAT_LABELS } from '../gameplay/stats.js';
import { RACES } from '../gameplay/missionData.js';
import { JOBS } from '../gameplay/jobs.js';
import { POSTCARD_COUNT } from '../gameplay/services.js';
import { TIME_MODES } from '../world/environment.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const TABS = [
  ['map', 'Map'],
  ['brief', 'Brief'],
  ['stats', 'Stats'],
  ['settings', 'Settings'],
  ['controls', 'Controls'],
  ['game', 'Game'],
];

export class Menus {
  constructor() {
    this.title = $('title');
    this.pause = $('pause');
    this.dialog = $('dialog');
    this.tab = 'map';
    this.log = [];
    this.onKey = this.onKey.bind(this);
    addEventListener('keydown', this.onKey, true);
    for (const t of ['subtitle', 'help']) events.on(t, ({ text }) => this.addLog(text));
    events.on('mission:passed', ({ mission }) => this.addLog(`Mission passed: ${mission.title}`));
    events.on('mission:failed', ({ mission, reason }) => this.addLog(`Mission failed: ${mission.title} — ${reason}`));
    events.on('safehouse', () => this.openSave(true));
  }

  addLog(text) {
    if (!text) return;
    this.log.unshift(text);
    this.log.length = Math.min(this.log.length, 14);
  }

  // ---------------------------------------------------------------- title
  showTitle({ onContinue, onNew, onLoad }) {
    this.handlers = { onContinue, onNew, onLoad };
    const latest = ctx.game.latestSave();
    this.title.innerHTML = `
      <div class="title-col">
        <h1>FRANKFURT<span>OPEN ROADS</span></h1>
        <nav class="menu-list" role="menu">
          <button class="menu-item" data-a="continue" ${latest ? '' : 'disabled'}>Continue${latest ? `<small>${esc(latest.data.label)} · ${new Date(latest.data.savedAt).toLocaleString()}</small>` : '<small>No saved game yet</small>'}</button>
          <button class="menu-item" data-a="new">New game<small>Free roam in Frankfurt · jobs, races and more</small></button>
          <button class="menu-item" data-a="load">Load game</button>
          <button class="menu-item" data-a="settings">Settings</button>
          <button class="menu-item" data-a="controls">Controls</button>
          <button class="menu-item" data-a="credits">Credits</button>
        </nav>
      </div>
      <div class="title-foot">v3.0 · Built with three.js and Rapier</div>
      <div class="title-hint keyhint"><kbd>↑</kbd> <kbd>↓</kbd> select · <kbd>Enter</kbd> confirm</div>`;
    this.title.classList.remove('hidden');
    this.title.querySelector('.menu-list').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      ctx.audio.init();
      ctx.audio.uiSelect();
      this.titleAction(b.dataset.a, latest);
    });
    this.focusFirst(this.title);
  }

  titleAction(a, latest) {
    if (a === 'continue') this.handlers.onContinue(latest.data);
    else if (a === 'new') this.handlers.onNew();
    else if (a === 'load') this.openLoad((data) => this.handlers.onLoad(data));
    else if (a === 'settings') this.openDialog('Settings', (body) => this.renderSettings(body));
    else if (a === 'controls') this.openDialog('Controls', (body) => this.renderControls(body));
    else if (a === 'credits') this.openDialog('Credits', (body) => this.renderCredits(body));
  }

  hideTitle() {
    this.title.classList.add('hidden');
  }

  // ---------------------------------------------------------------- pause
  openPause(tab = null) {
    if (ctx.game.state !== 'playing') return;
    ctx.game.state = 'paused';
    ctx.audio.setPaused(true);
    input.enabled = false;
    input.unlockPointer();
    ctx.hud.show(false);
    this.tab = tab || this.tab;
    const p = ctx.player.position;
    const date = ctx.env.date;
    this.pause.innerHTML = `
      <div class="pause-head">
        <div class="pause-brand">FRANKFURT<span>OPEN ROADS</span></div>
        <div class="pause-info">
          <div>${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(date)}</div>
          <div class="money">${formatMoney(ctx.player.money)}</div>
          <div style="color:var(--muted);font-size:14px">${esc(ctx.game.district(p))}</div>
        </div>
      </div>
      <div class="tabs" role="tablist">${TABS.map(([id, label]) => `<button class="tab" role="tab" data-tab="${id}">${label}</button>`).join('')}</div>
      <div class="tab-body"><div class="tab-page"></div></div>
      <div class="pause-foot keyhint"><span><kbd>Q</kbd> <kbd>E</kbd> switch tab</span><span><kbd>Esc</kbd> resume</span></div>`;
    this.pause.classList.remove('hidden');
    this.pause.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) this.showTab(b.dataset.tab);
    });
    this.showTab(this.tab);
  }

  closePause() {
    if (ctx.game.state !== 'paused') return;
    ctx.map.unmount();
    this.pause.classList.add('hidden');
    this.pause.innerHTML = '';
    ctx.game.state = 'playing';
    ctx.audio.setPaused(false);
    input.enabled = true;
    if (!input.isTouch) input.lockPointer();
    ctx.hud.show(true);
    ctx.audio.uiBack();
  }

  showTab(id) {
    this.tab = id;
    ctx.map.unmount();
    for (const b of this.pause.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === id);
    const page = this.pause.querySelector('.tab-page');
    page.style.padding = id === 'map' ? '0' : '';
    page.innerHTML = '';
    page.scrollTop = 0;
    ({
      map: () => ctx.map.mount(page),
      brief: () => this.renderBrief(page),
      stats: () => this.renderStats(page),
      settings: () => this.renderSettings(page),
      controls: () => this.renderControls(page),
      game: () => this.renderGame(page),
    })[id]();
    ctx.audio.uiMove();
  }

  cycleTab(d) {
    const i = TABS.findIndex(([t]) => t === this.tab);
    this.showTab(TABS[(i + d + TABS.length) % TABS.length][0]);
  }

  renderBrief(page) {
    const m = ctx.missions;
    const prog = m.progress;
    const active = m.active;
    let html = '<div class="brief-list">';
    if (active) html += `<div class="brief-card"><h3>Now: ${esc(active.def.title)}</h3><p>${esc(m.objective || 'In progress')}</p></div>`;
    html += '<div class="section-title">Street races</div>';
    for (const r of RACES) {
      const best = prog.races[r.id];
      html += `<div class="brief-card ${best ? 'done' : ''}"><h3>${esc(r.title)}</h3><p>Drive into the white flag marker in any vehicle. Gold ${r.medals[0]} s · Silver ${r.medals[1]} s · Bronze ${r.medals[2]} s${best ? ` · Best ${best.toFixed(1)} s` : ''}</p></div>`;
    }
    html += '<div class="section-title">Jobs</div>';
    const how = {
      taxi: 'Get into a taxi (taxi rank T on the map) and press',
      courier: 'Get into a courier van (depot C) and press',
      bus: 'Get into a city bus at the bus depot (B) and press',
      tow: 'Get into a tow truck at a tow service (A) and press',
      ambulance: 'Get into an ambulance at a hospital (+) and press',
      uber: 'Open the phone and go online in the Uber app (any car).',
      eats: 'Open the phone, Uber app, Eats tab (any vehicle; delivery scooters at restaurants).',
    };
    const jobKey = keyName(settings.get('bindings').job[0]);
    for (const j of JOBS) {
      const st = prog.jobs?.[j.id];
      const text = how[j.id].endsWith('press') ? `${how[j.id]} <b>${jobKey}</b>.` : how[j.id];
      html += `<div class="brief-card ${st?.done ? 'done' : ''}"><h3>${esc(j.title)}</h3><p>${text}${st ? ` Completed: ${st.done} · earned ${formatMoney(st.earned)}` : ''}</p></div>`;
    }
    html += `<div class="section-title">Collectibles</div><div class="brief-card"><h3>Postcards ${ctx.services.found.size}/${POSTCARD_COUNT}</h3><p>Hidden next to the skyline's towers. €100 each, €2.500 for the full set.</p></div>`;
    html += `</div><div class="section-title" style="margin-top:22px">Recent messages</div><div class="log">${this.log.map(esc).join('<br>') || '—'}</div>`;
    page.innerHTML = html;
  }

  renderStats(page) {
    const pct = ctx.game.completion();
    let html = `<div class="completion"><div class="ring" style="--p:${pct}"><span>${pct}%</span></div><div><div style="font:800 22px var(--font-display);letter-spacing:.05em">GAME COMPLETION</div><div style="color:var(--muted);font-size:13px">Story, races, postcards and jobs</div></div></div><div class="stats-grid">`;
    for (const k in STAT_LABELS) html += `<div class="stat"><span>${STAT_LABELS[k][0]}</span><b>${ctx.stats.format(k)}</b></div>`;
    page.innerHTML = `${html}</div>`;
  }

  renderGame(page) {
    page.innerHTML = `
      <div class="section-title">Game</div>
      <div class="btn-row" style="flex-direction:column;align-items:flex-start;max-width:320px">
        <button class="btn primary" data-a="resume">Resume</button>
        <button class="btn" data-a="save">Save game</button>
        <button class="btn" data-a="load">Load game</button>
        <button class="btn" data-a="new">New game</button>
        <button class="btn danger" data-a="quit">Quit to title</button>
      </div>
      <p style="margin-top:16px;color:var(--muted);font-size:13px;max-width:520px">You can save at any time while the police aren't after you. Walk into the white marker at the safehouse in Westend to sleep and save. Story missions save automatically.</p>`;
    page.addEventListener('click', (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (!a) return;
      ctx.audio.uiSelect();
      if (a === 'resume') this.closePause();
      else if (a === 'save') this.openSave(false);
      else if (a === 'load')
        this.openLoad((data) => {
          ctx.game.load(data);
          this.closeDialog();
          this.closePause();
        });
      else if (a === 'new')
        this.confirm('Start a new game? Unsaved progress will be lost.', () => {
          ctx.game.newGame();
          this.closeDialog();
          this.closePause();
        });
      else if (a === 'quit') this.confirm('Quit to the title screen? Unsaved progress will be lost.', () => location.reload());
    });
  }

  // ---------------------------------------------------------------- settings
  renderSettings(page) {
    const s = settings;
    const sel = (key, label, opts, help = '') =>
      `<div class="opt-row"><label>${label}${help ? `<small>${help}</small>` : ''}</label><select data-k="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(s.get(key)) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
    const range = (key, label, min, max, step, help = '') =>
      `<div class="opt-row"><label>${label}${help ? `<small>${help}</small>` : ''}</label><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${s.get(key)}"></div>`;
    const toggle = (key, label, help = '') =>
      `<div class="opt-row"><label>${label}${help ? `<small>${help}</small>` : ''}</label><button class="toggle ${s.get(key) ? 'on' : ''}" data-t="${key}" aria-pressed="${!!s.get(key)}" aria-label="${label}"></button></div>`;
    page.innerHTML = `
      <div class="section-title">Display</div>
      ${sel(
        'quality',
        'Graphics quality',
        [
          ['auto', 'Auto (detect hardware)'],
          ['low', 'Low · integrated graphics'],
          ['medium', 'Medium'],
          ['high', 'High'],
          ['ultra', 'Ultra · dedicated GPU'],
        ],
        'Some world detail applies after a restart',
      )}
      ${range('fov', 'Field of view', 50, 85, 1)}
      ${range('drawDistance', 'View distance', 0.6, 1.6, 0.1, 'Fog density')}
      ${toggle('minimapRotate', 'Rotate minimap with camera')}
      ${sel('units', 'Speed units', [
        ['kmh', 'km/h'],
        ['mph', 'mph'],
      ])}
      ${toggle('showHelp', 'Show help messages')}
      <div class="section-title">Audio</div>
      ${range('masterVolume', 'Master volume', 0, 1, 0.05)}
      ${range('sfxVolume', 'Effects', 0, 1, 0.05)}
      ${range('radioVolume', 'Radio', 0, 1, 0.05)}
      ${range('ambientVolume', 'Ambience & weather', 0, 1, 0.05)}
      <div class="section-title">Camera & controls</div>
      ${range('mouseSensitivity', 'Look sensitivity', 0.3, 2.5, 0.05)}
      ${toggle('invertY', 'Invert vertical look')}
      ${toggle('autoCenterCamera', 'Auto-centre camera behind vehicles')}
      <div class="section-title">World</div>
      ${sel('weatherMode', 'Weather', [
        ['live', 'Live Frankfurt weather'],
        ['clear', 'Clear'],
        ['cloudy', 'Overcast'],
        ['rain', 'Rain'],
        ['storm', 'Thunderstorm'],
        ['snow', 'Snow'],
        ['fog', 'Fog'],
      ])}
      ${sel(
        'timeMode',
        'Time',
        Object.entries(TIME_MODES).map(([k, [, l]]) => [k, l]),
      )}
      <div class="opt-row"><label>Jump to hour<small>Leaves real-time mode</small></label><input type="range" data-hour min="0" max="23" step="1" value="${new Date(ctx.env?.gameTime || Date.now()).getHours()}"></div>
      ${range('trafficDensity', 'Traffic density', 0.3, 1.5, 0.1)}
      ${range('pedDensity', 'Pedestrian density', 0.3, 1.5, 0.1)}`;
    page.addEventListener('change', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      const v = e.target.type === 'range' ? parseFloat(e.target.value) : e.target.value;
      s.set(k, v);
    });
    page.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (k && e.target.type === 'range') s.set(k, parseFloat(e.target.value));
      if (e.target.dataset.hour !== undefined) {
        ctx.env.setHour(parseInt(e.target.value, 10));
        const t = page.querySelector('select[data-k="timeMode"]');
        if (t) t.value = settings.get('timeMode');
      }
    });
    page.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]');
      if (!b) return;
      const k = b.dataset.t;
      s.set(k, !s.get(k));
      b.classList.toggle('on', !!s.get(k));
      b.setAttribute('aria-pressed', String(!!s.get(k)));
      ctx.audio.uiMove();
    });
  }

  renderControls(page) {
    const b = settings.get('bindings');
    let rows = '';
    for (const a in ACTION_LABELS) {
      rows += `<div class="opt-row"><label>${ACTION_LABELS[a]}</label><div class="bind-cell">${[0, 1].map((slot) => `<button class="bind-btn" data-a="${a}" data-s="${slot}">${keyName(b[a][slot])}</button>`).join('')}</div></div>`;
    }
    page.innerHTML = `
      <div class="section-title">Keyboard & mouse</div>
      <p style="color:var(--muted);font-size:13px;margin-bottom:8px">Click a key to rebind it, then press the new key (Esc cancels). Mouse: look around · wheel: zoom camera.</p>
      ${rows}
      <div class="btn-row"><button class="btn" data-reset>Reset to defaults</button></div>
      <div class="section-title">Gamepad</div>
      <div class="stats-grid">
        ${[
          ['Left stick', 'Move / steer'],
          ['Right stick', 'Camera'],
          ['RT / LT', 'Accelerate / brake & reverse'],
          ['A', 'Jump / handbrake'],
          ['Y', 'Enter / exit vehicle'],
          ['X', 'Sprint'],
          ['L3', 'Horn / siren'],
          ['R3', 'Look behind'],
          ['D-pad ↑', 'Change camera'],
          ['D-pad →', 'Next radio station'],
          ['D-pad ←', 'Start / stop job'],
          ['D-pad ↓', 'Flip vehicle'],
          ['View', 'Map'],
          ['RB', 'Phone'],
          ['Menu', 'Pause'],
        ]
          .map(([k, v]) => `<div class="stat"><span>${v}</span><b>${k}</b></div>`)
          .join('')}
      </div>
      <div class="section-title">Touch</div>
      <p style="color:var(--muted);font-size:13px">Left side of the screen: virtual joystick. Right side: drag to look. Buttons for jump, run, vehicle, horn, camera and map.</p>`;
    page.addEventListener('click', (e) => {
      if (e.target.closest('[data-reset]')) {
        settings.resetBindings();
        this.renderControls(page);
        return;
      }
      const btn = e.target.closest('.bind-btn');
      if (!btn) return;
      btn.classList.add('listening');
      btn.textContent = 'Press a key…';
      this.capturing = true;
      input.captureNext((code) => {
        this.capturing = false;
        if (code) settings.bind(btn.dataset.a, Number(btn.dataset.s), code);
        this.renderControls(page);
      });
    });
  }

  renderCredits(body) {
    body.innerHTML = `
      <p style="line-height:1.7;font-size:14px">
        <b>Frankfurt: Open Roads</b> — an open-world driving game set in Frankfurt's real city centre.<br><br>
        Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).<br>
        Live weather: Deutscher Wetterdienst via Bright Sky, with Open-Meteo as fallback.<br>
        Sun and moon positions: SunCalc. Rendering: three.js. Physics: Rapier.<br>
        All 3D models, music and sound effects are generated procedurally by the game's own code.<br><br>
        Restaurants, companies and people in the game are fictional.
      </p>`;
  }

  // ---------------------------------------------------------------- dialogs
  openDialog(title, render) {
    this.dialog.innerHTML = `<div class="dialog-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="dialog-head"><h2>${esc(title)}</h2><button class="close-x" aria-label="Close">✕</button></div><div class="dialog-body"></div></div>`;
    this.dialog.classList.remove('hidden');
    this.dialog.querySelector('.close-x').onclick = () => this.closeDialog();
    this.dialog.onclick = (e) => {
      if (e.target === this.dialog) this.closeDialog();
    };
    render(this.dialog.querySelector('.dialog-body'));
    this.focusFirst(this.dialog);
  }
  closeDialog() {
    if (this.dialog.classList.contains('hidden')) return false;
    this.dialog.classList.add('hidden');
    this.dialog.innerHTML = '';
    ctx.audio.uiBack();
    this.afterDialog();
    return true;
  }

  slotLabel(s) {
    const name = s.slot === 'auto' ? 'Autosave' : `Slot ${s.slot}`;
    return s.data
      ? `<span><b>${name}</b><small>${esc(s.data.label)}</small></span><small>${new Date(s.data.savedAt).toLocaleString()}</small>`
      : `<span><b>${name}</b><small>Empty</small></span>`;
  }

  openLoad(onLoad) {
    this.openDialog('Load game', (body) => {
      const saves = ctx.game.listSaves();
      body.innerHTML = `<div class="save-slots">${saves.map((s) => `<button class="save-slot" data-slot="${s.slot}" ${s.data ? '' : 'disabled'}>${this.slotLabel(s)}</button>`).join('')}</div>`;
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-slot]');
        if (!b || b.disabled) return;
        const s = saves.find((x) => x.slot === b.dataset.slot);
        this.closeDialog();
        onLoad(s.data);
      });
    });
  }

  /** @param {boolean} sleep safehouse save: also advances time and restores health */
  openSave(sleep) {
    if (ctx.game.state === 'playing') {
      ctx.game.state = 'paused';
      input.enabled = false;
      input.unlockPointer();
      this.resumeAfterDialog = true;
    }
    this.openDialog(sleep ? 'Safehouse' : 'Save game', (body) => {
      const saves = ctx.game.listSaves().filter((s) => s.slot !== 'auto');
      body.innerHTML = `${sleep ? '<p style="color:var(--muted);font-size:13px;margin-bottom:12px">Choose a slot to sleep and save. Sleeping restores your health and passes 6 hours.</p>' : ''}<div class="save-slots">${saves.map((s) => `<button class="save-slot" data-slot="${s.slot}">${this.slotLabel(s)}</button>`).join('')}</div>`;
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-slot]');
        if (!b) return;
        if (sleep) {
          ctx.player.heal(100);
          if (ctx.env.timeMode !== 'real') ctx.env.advanceHours(6);
        }
        if (ctx.game.save(b.dataset.slot)) ctx.audio.uiSelect();
        this.closeDialog();
      });
    });
  }

  afterDialog() {
    if (this.resumeAfterDialog) {
      this.resumeAfterDialog = false;
      ctx.game.state = 'playing';
      input.enabled = true;
      if (!input.isTouch) input.lockPointer();
    }
  }

  confirm(text, onYes) {
    this.openDialog('Are you sure?', (body) => {
      body.innerHTML = `<p style="font-size:15px">${esc(text)}</p><div class="btn-row"><button class="btn primary" data-y>Yes</button><button class="btn" data-n>Cancel</button></div>`;
      body.querySelector('[data-y]').onclick = onYes;
      body.querySelector('[data-n]').onclick = () => this.closeDialog();
    });
  }

  focusFirst(root) {
    requestAnimationFrame(() => root.querySelector('button:not([disabled]), select, input')?.focus());
  }

  /** Global keyboard handling for menus (capture phase, before gameplay input). */
  onKey(e) {
    if (this.capturing) return;
    const dialogOpen = !this.dialog.classList.contains('hidden');
    const pauseOpen = !this.pause.classList.contains('hidden');
    const titleOpen = !this.title.classList.contains('hidden');
    if (e.code === 'Escape' || (e.code === 'KeyP' && pauseOpen)) {
      if (dialogOpen) {
        this.closeDialog();
        e.stopPropagation();
        return;
      }
      if (pauseOpen) {
        this.closePause();
        e.stopPropagation();
      }
      return;
    }
    if (pauseOpen && !dialogOpen) {
      const onMap = this.tab === 'map' && document.activeElement?.closest?.('.map-canvas');
      if (e.code === 'KeyQ') this.cycleTab(-1);
      else if (e.code === 'KeyE') this.cycleTab(1);
      else if (e.code === 'KeyM' && this.tab === 'map') this.closePause();
      else if (!onMap && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) this.moveFocus(this.pause, e.code === 'ArrowDown' ? 1 : -1);
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if ((titleOpen || dialogOpen) && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      this.moveFocus(dialogOpen ? this.dialog : this.title, e.code === 'ArrowDown' ? 1 : -1);
      e.preventDefault();
      e.stopPropagation();
    }
  }

  moveFocus(root, d) {
    const items = [...root.querySelectorAll('button:not([disabled]), select, input')].filter((el) => el.offsetParent);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    items[(i + d + items.length) % items.length].focus();
    ctx.audio.uiMove();
  }
}
