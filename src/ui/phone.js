/**
 * In-game iPhone (toggle with E): home screen and apps.
 *   Uber       go online for ride requests (Rides) or food orders (Eats); accept to start the job
 *   Instagram  your profile and posts; likes and followers grow after posting
 *   Camera     photo mode: take a picture of the game, then post it to Instagram
 *   WhatsApp   chats with contacts who send job offers (bus, tow, ambulance, taxi) and small talk
 *   Maps       local map with places; set waypoints or open the full map
 *   Bank       balance and transaction history
 *   Settings   notifications, wallpaper, volume, game settings and save
 * App icons are original simple designs in the services' colours (not the official logos).
 */
import { ctx } from '../core/context.js';
import { events } from '../core/events.js';
import { input } from '../core/input.js';
import { settings, keyName } from '../core/settings.js';
import { formatMoney, rnd } from '../core/math.js';
import { canDoUber, makeEatsRequest, makeRideRequest } from '../gameplay/jobs.js';
import { drawBlip, LAND_COLOR } from './mapRenderer.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const MAX_PHOTOS = 12;
const WALLPAPERS = ['linear-gradient(160deg,#1d2b64,#f8cdda)', 'linear-gradient(160deg,#0f2027,#2c5364)', 'linear-gradient(160deg,#ff9966,#ff5e62)', 'linear-gradient(160deg,#134e5e,#71b280)'];

const ICONS = {
  uber: '<div class="ic ic-uber"><span>Uber</span></div>',
  instagram: '<div class="ic ic-insta"><svg viewBox="0 0 40 40"><rect x="9" y="9" width="22" height="22" rx="7" fill="none" stroke="#fff" stroke-width="3"/><circle cx="20" cy="20" r="5.5" fill="none" stroke="#fff" stroke-width="3"/><circle cx="26.5" cy="13.5" r="1.8" fill="#fff"/></svg></div>',
  whatsapp: '<div class="ic ic-wa"><svg viewBox="0 0 40 40"><path d="M20 8a12 12 0 0 0-10.3 18.2L8 32l6-1.6A12 12 0 1 0 20 8z" fill="none" stroke="#fff" stroke-width="2.6"/><path d="M15.5 14.5c.4-.9 1.4-.9 1.8 0l1 2.2-1.1 1.4c.8 1.7 2.1 3 3.8 3.8l1.4-1.1 2.2 1c.9.4.9 1.4 0 1.8-1.3.7-2.8.7-4.3 0a10 10 0 0 1-4.8-4.8c-.7-1.5-.7-3 0-4.3z" fill="#fff"/></svg></div>',
  camera: '<div class="ic ic-cam"><svg viewBox="0 0 40 40"><rect x="7" y="13" width="26" height="18" rx="4" fill="#fff"/><rect x="15" y="10" width="10" height="5" rx="2" fill="#fff"/><circle cx="20" cy="22" r="5.5" fill="#555"/><circle cx="20" cy="22" r="3.5" fill="#222"/></svg></div>',
  maps: '<div class="ic ic-maps"><svg viewBox="0 0 40 40"><path d="M6 10l9-3 10 3 9-3v23l-9 3-10-3-9 3z" fill="#e8f4ea"/><path d="M15 7v23M25 10v23" stroke="#9cc8a8" stroke-width="1.5"/><path d="M20 12a5 5 0 0 0-5 5c0 4 5 9 5 9s5-5 5-9a5 5 0 0 0-5-5z" fill="#e5484d"/><circle cx="20" cy="17" r="1.8" fill="#fff"/></svg></div>',
  bank: '<div class="ic ic-bank"><svg viewBox="0 0 40 40"><path d="M8 15l12-7 12 7z" fill="#fff"/><rect x="10" y="17" width="3" height="10" fill="#fff"/><rect x="18.5" y="17" width="3" height="10" fill="#fff"/><rect x="27" y="17" width="3" height="10" fill="#fff"/><rect x="8" y="29" width="24" height="3" fill="#fff"/></svg></div>',
  settings: '<div class="ic ic-set"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="9" fill="none" stroke="#fff" stroke-width="5" stroke-dasharray="4 3.1"/><circle cx="20" cy="20" r="4" fill="#fff"/></svg></div>',
};
const APPS = [
  ['uber', 'Uber'],
  ['instagram', 'Instagram'],
  ['whatsapp', 'WhatsApp'],
  ['maps', 'Maps'],
  ['bank', 'Bank'],
  ['settings', 'Settings'],
];
const DOCK = [
  ['whatsapp', 'WhatsApp'],
  ['camera', 'Camera'],
  ['instagram', 'Instagram'],
  ['uber', 'Uber'],
];

const CONTACTS = {
  vgf: { name: 'VGF Leitstelle', avatar: '🚌', job: 'bus' },
  taxi: { name: 'Taxi-Zentrale', avatar: '🚕', job: 'taxi' },
  tow: { name: 'Abschleppdienst', avatar: '🛻', job: 'tow' },
  rettung: { name: 'Rettungsdienst Leitstelle', avatar: '🚑', job: 'ambulance' },
  courier: { name: 'Kurier-Disposition', avatar: '📦', job: 'van' },
  mama: { name: 'Mama', avatar: '👩' },
  jonas: { name: 'Jonas', avatar: '🧑' },
  media: { name: 'Mainhattan Media', avatar: '📣' },
};
const OFFERS = {
  vgf: ['Fahrer gesucht! A bus is waiting at the depot. Can you drive a shift?', 'Linie 36 needs a driver this afternoon. Bus is ready at the depot.'],
  taxi: ['Rush at the Hauptbahnhof! Grab a taxi at the rank and take fares.', 'We need more taxis tonight. Interested?'],
  tow: ['Breakdowns piling up in the city. Can you run the tow truck?', 'Tow truck free at the garage. Want a few jobs?'],
  rettung: ['We are short of paramedics. Can you take an ambulance shift?', 'Ambulance ready at the hospital. Can you help out?'],
  courier: ['Lots of parcels today. A van is waiting at the depot.', 'Need a courier for the afternoon round!'],
};
const SMALLTALK = {
  mama: ['Hast du heute schon was gegessen? 🍲', 'Ruf mal wieder an! 😘', 'Pass auf dich auf im Verkehr!', 'Am Sonntag gibt es Grüne Soße, kommst du?'],
  jonas: ['Bro, Uber zahlt gerade richtig gut 💸', 'Apfelwein in Sachsenhausen heute Abend? 🍏', 'Hast du das Foto vom Main Tower gepostet? Krass!', 'Eintracht spielt am Samstag ⚽'],
};

export class Phone {
  constructor() {
    this.open = false;
    this.app = 'home';
    this.chat = null;
    this.camera = false;
    this.draft = null;
    this.request = null;
    this.reqTimer = 8;
    this.offerTimer = 60;
    this.chatTimer = 40;
    this.data = Phone.empty();
  }

  static empty() {
    return {
      followers: 120,
      photos: [],
      chats: {},
      unread: {},
      transactions: [],
      uber: { online: false, mode: 'ride', rides: 0, eats: 0, stars: 0, rated: 0, earned: 0 },
      notifications: true,
      wallpaper: 0,
    };
  }

  build() {
    const root = (this.root = document.createElement('div'));
    root.id = 'phone';
    root.className = 'hidden';
    root.innerHTML = '<div class="ph-frame"><div class="ph-island"></div><div class="ph-status"></div><div class="ph-screen"></div><div class="ph-home" title="Home"></div></div>';
    document.body.appendChild(root);
    this.screen = root.querySelector('.ph-screen');
    this.status = root.querySelector('.ph-status');
    root.querySelector('.ph-home').onclick = () => this.go('home');
    this.screen.addEventListener('click', (e) => this.onClick(e));
    this.banner = document.createElement('div');
    this.banner.id = 'phone-banner';
    document.body.appendChild(this.banner);
    this.cam = document.createElement('div');
    this.cam.id = 'phone-cam';
    this.cam.className = 'hidden';
    this.cam.innerHTML = '<div class="cam-frame"></div><div class="cam-hint">Space / click: take photo · Esc: back · mouse drag: aim</div><button class="cam-shutter" aria-label="Take photo"></button>';
    document.body.appendChild(this.cam);
    this.cam.querySelector('.cam-shutter').onclick = () => this.shoot();
    addEventListener('keydown', (e) => this.onKey(e), true);
    this.bindInputs();
    events.on('money', ({ amount, reason }) => {
      this.data.transactions.unshift({ t: ctx.env?.gameTime ?? Date.now(), amount, reason: reason || (amount > 0 ? 'Payment' : 'Payment sent') });
      this.data.transactions.length = Math.min(this.data.transactions.length, 40);
      if (this.open && this.app === 'bank') this.render();
    });
    events.on('uber:completed', ({ kind, stars, fare, name }) => {
      const u = this.data.uber;
      if (kind === 'ride') u.rides++;
      else u.eats++;
      u.stars += stars;
      u.rated++;
      u.earned += fare;
      this.notify('uber', 'Uber', `${name} rated you ${'★'.repeat(stars)}${'☆'.repeat(5 - stars)} · ${formatMoney(fare)}`);
      if (this.open && this.app === 'uber') this.render();
    });
    this.renderStatus();
  }

  /** First messages of a new game. */
  welcome() {
    this.message('mama', 'Willkommen in Frankfurt! Melde dich mal 😘', false);
    this.message('jonas', 'Bro, Uber zahlt gerade gut. Check die App! Für Busse und Abschleppwagen schreiben dir die Leitstellen.', false);
  }

  // ---------------------------------------------------------------- open/close
  toggle() {
    if (this.camera) return this.exitCamera();
    this.setOpen(!this.open);
  }
  setOpen(on) {
    if (this.open === on) return;
    this.open = on;
    this.root.classList.toggle('hidden', !on);
    if (on) {
      input.unlockPointer();
      this.render();
      ctx.audio.uiSelect();
    } else {
      this.chat = null;
      if (!input.isTouch && ctx.game.state === 'playing') input.lockPointer();
      ctx.audio.uiBack();
    }
  }
  go(app, opts = {}) {
    this.app = app;
    this.chat = opts.chat ?? null;
    if (app === 'camera') return this.enterCamera();
    this.render();
    ctx.audio.uiMove();
  }
  back() {
    if (this.chat) {
      this.chat = null;
      return this.render();
    }
    if (this.app !== 'home') return this.go('home');
    this.setOpen(false);
  }

  onKey(e) {
    if (this.camera) {
      if (e.code === 'Space' || e.code === 'Enter') this.shoot();
      else if (e.code === 'Escape' || e.code === 'Backspace') this.exitCamera();
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!this.open) return;
    if (e.target?.tagName === 'INPUT') return;
    if (e.code === 'Escape' || e.code === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      this.back();
    }
  }

  // ---------------------------------------------------------------- notifications & messages
  notify(app, title, text) {
    if (!this.data.notifications) return;
    this.banner.innerHTML = `${ICONS[app] || ''}<div><b>${esc(title)}</b><span>${esc(text)}</span></div>`;
    this.banner.classList.remove('show');
    void this.banner.offsetWidth;
    this.banner.classList.add('show');
    clearTimeout(this.bannerT);
    this.bannerT = setTimeout(() => this.banner.classList.remove('show'), 4200);
    ctx.audio.tone(1568, 0.08, 'sine', 0.04, 'ui');
    ctx.audio.tone(2093, 0.1, 'sine', 0.035, 'ui', 0.09);
  }

  /** Adds a chat message. actions: [{label, id}] buttons handled by onAction. */
  message(contact, text, banner = true, actions = null, from = 'them') {
    const list = (this.data.chats[contact] ||= []);
    list.push({ from, text, actions, t: ctx.env?.gameTime ?? Date.now() });
    if (list.length > 30) list.shift();
    if (from === 'them') {
      const viewing = this.open && this.app === 'whatsapp' && this.chat === contact;
      if (!viewing) this.data.unread[contact] = (this.data.unread[contact] || 0) + 1;
      if (banner) this.notify('whatsapp', CONTACTS[contact].name, text);
    }
    if (this.open && this.app === 'whatsapp') this.render();
  }

  onAction(contact, idx, action) {
    const msg = this.data.chats[contact]?.[idx];
    if (!msg?.actions) return;
    msg.actions = null;
    const c = CONTACTS[contact];
    if (action === 'accept' && c.job) {
      const d = ctx.depots.nearest(c.job);
      if (d) ctx.map.setWaypoint(d.x, d.z);
      this.message(contact, 'Bin unterwegs! 👍', false, null, 'me');
      setTimeout(() => this.message(contact, `Super! The vehicle is at “${d?.label || 'the depot'}”. Waypoint set. Get in and press J.`), 1500);
    } else if (action === 'decline') {
      this.message(contact, 'Heute leider nicht, sorry.', false, null, 'me');
    } else if (action === 'like') {
      this.message(contact, '👍', false, null, 'me');
    }
    this.render();
  }

  // ---------------------------------------------------------------- per-frame
  update(dt) {
    this.statusT = (this.statusT || 0) - dt;
    if (this.statusT <= 0) {
      this.statusT = 1;
      this.renderStatus();
      if (this.open && this.app === 'uber' && this.request) this.render();
      if (this.open && this.app === 'maps') this.drawMap();
    }
    if (ctx.game.state !== 'playing') return;
    this.updateUber(dt);
    this.updateLikes(dt);
    // job offers and small talk
    const busy = !!ctx.missions.active;
    this.offerTimer -= dt;
    if (this.offerTimer <= 0) {
      this.offerTimer = 120 + rnd() * 120;
      if (!busy) {
        const id = rnd.pick(Object.keys(OFFERS));
        this.message(id, rnd.pick(OFFERS[id]), true, [
          { label: 'Accept', id: 'accept' },
          { label: 'Decline', id: 'decline' },
        ]);
      }
    }
    this.chatTimer -= dt;
    if (this.chatTimer <= 0) {
      this.chatTimer = 150 + rnd() * 200;
      const id = rnd.pick(Object.keys(SMALLTALK));
      this.message(id, rnd.pick(SMALLTALK[id]), true, [{ label: '👍', id: 'like' }]);
    }
  }

  updateUber(dt) {
    const u = this.data.uber;
    const car = ctx.player.vehicle;
    const eligible = u.online && !ctx.missions.active && car && (u.mode === 'eats' || canDoUber(car));
    if (this.request) {
      this.request.ttl -= dt;
      if (this.request.ttl <= 0 || !eligible) {
        this.request = null;
        if (this.open && this.app === 'uber') this.render();
      }
      return;
    }
    if (!eligible) return;
    this.reqTimer -= dt;
    if (this.reqTimer > 0) return;
    this.reqTimer = 10 + rnd() * 15;
    this.request = { ...(u.mode === 'ride' ? makeRideRequest() : makeEatsRequest()), ttl: 20 };
    this.notify('uber', u.mode === 'ride' ? 'Uber · New ride request' : 'Uber Eats · New order', `${formatMoney(this.request.fare)} · ${this.request.tripKm.toFixed(1)} km — open the phone (${keyName(settings.get('bindings').phone[0])}) to accept`);
    if (this.open && this.app === 'uber') this.render();
  }

  acceptRequest() {
    const req = this.request;
    if (!req) return;
    this.request = null;
    if (ctx.missions.startJob(req.kind === 'ride' ? 'uber' : 'eats', req)) this.setOpen(false);
    else this.render();
  }

  // ---------------------------------------------------------------- camera & Instagram
  enterCamera() {
    this.camera = true;
    this.root.classList.add('hidden');
    this.cam.classList.remove('hidden');
    ctx.hud.show(false);
    this.open = false;
  }
  exitCamera() {
    this.camera = false;
    this.cam.classList.add('hidden');
    ctx.hud.show(true);
    this.setOpen(true);
    this.go(this.draft ? 'post' : 'home');
  }

  shoot() {
    // render a frame and copy it before the browser clears the drawing buffer
    ctx.pipeline.render();
    const src = ctx.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = 480;
    c.height = Math.round((480 * src.height) / src.width);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    const where = this.photoPlace();
    this.draft = { src: c.toDataURL('image/jpeg', 0.72), place: where.name, landmark: where.landmark, caption: '' };
    this.cam.classList.add('flash');
    setTimeout(() => this.cam.classList.remove('flash'), 180);
    ctx.audio.burst(0.12, 4000, 0.08, 'highpass', 'ui');
    this.exitCamera();
  }

  /** The landmark in front of the camera, or the district. */
  photoPlace() {
    const cam = ctx.camera;
    const fx = -Math.sin(ctx.cameraRig.yaw), fz = -Math.cos(ctx.cameraRig.yaw);
    let best = null,
      bs = 0;
    for (const n of ctx.city.names) {
      const dx = n.x - cam.position.x, dz = n.z - cam.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 700 || d < 5) continue;
      const facing = (dx * fx + dz * fz) / d;
      const score = facing * (n.h / 100) * (1 - d / 900);
      if (facing > 0.75 && score > bs) {
        bs = score;
        best = n;
      }
    }
    return best ? { name: best.name, landmark: true } : { name: ctx.game.district(ctx.player.position), landmark: false };
  }

  post() {
    const d = this.draft;
    if (!d) return;
    const input = this.screen.querySelector('.ig-caption');
    d.caption = input?.value?.slice(0, 120) || '';
    const env = ctx.env;
    const sunY = env.sunDir?.y ?? 0.5;
    const golden = sunY > -0.03 && sunY < 0.18 ? 1.7 : 1;
    const night = sunY < -0.1 ? 1.2 : 1;
    const target = Math.round((12 + this.data.followers * 0.06) * (d.landmark ? 2.6 : 1) * golden * night * (0.7 + rnd() * 0.6));
    const photo = { id: `p${Date.now()}`, src: d.src, caption: d.caption, place: d.place, likes: 0, target, t: env.gameTime };
    this.data.photos.unshift(photo);
    if (this.data.photos.length > MAX_PHOTOS) this.data.photos.pop();
    this.draft = null;
    ctx.stats.add('photosPosted', 1);
    if (d.landmark) {
      const pay = 15 + Math.round(target * 0.4);
      ctx.player.addMoney(pay, 'Instagram sponsor');
      this.notify('instagram', 'Instagram', `Sponsored post at ${d.place}: ${formatMoney(pay)}`);
    }
    this.go('instagram');
  }

  updateLikes(dt) {
    this.likeT = (this.likeT || 0) - dt;
    if (this.likeT > 0) return;
    this.likeT = 4;
    let gained = 0;
    for (const p of this.data.photos) {
      if (p.likes >= p.target) continue;
      const add = Math.max(1, Math.round((p.target - p.likes) * 0.12));
      p.likes = Math.min(p.target, p.likes + add);
      gained += add;
    }
    if (!gained) return;
    const before = this.data.followers;
    this.data.followers += Math.round(gained * 0.25 + rnd() * 2);
    for (const m of [250, 500, 1000, 2500, 5000]) {
      if (before < m && this.data.followers >= m) {
        this.message('media', `Congrats on ${m} followers! We'd like to sponsor you: ${formatMoney(m)} for a feature 📣`, true);
        ctx.player.addMoney(m, 'Brand deal');
      }
    }
    if (gained >= 5) this.notify('instagram', 'Instagram', `${gained} new likes on your posts ❤`);
    if (this.open && this.app === 'instagram') this.render();
  }

  // ---------------------------------------------------------------- rendering
  renderStatus() {
    if (!this.status || !ctx.env) return;
    const t = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(ctx.env.date);
    this.status.innerHTML = `<span>${t}</span><span class="ph-icons">▂▄▆█ 5G <i class="ph-batt"></i></span>`;
  }

  render() {
    if (!this.screen) return;
    this.screen.style.background = this.app === 'home' ? WALLPAPERS[this.data.wallpaper % WALLPAPERS.length] : '';
    this.screen.dataset.app = this.app;
    const fn = { home: this.homeView, uber: this.uberView, instagram: this.instaView, post: this.postView, whatsapp: this.waView, maps: this.mapsView, bank: this.bankView, settings: this.settingsView }[this.app] || this.homeView;
    this.screen.innerHTML = fn.call(this);
    if (this.app === 'maps') this.drawMap();
    if (this.app === 'whatsapp' && this.chat) {
      const log = this.screen.querySelector('.wa-log');
      if (log) log.scrollTop = log.scrollHeight;
    }
  }

  header(title, extra = '') {
    return `<div class="app-head"><button data-back class="app-back" aria-label="Back">‹</button><h3>${title}</h3>${extra}</div>`;
  }

  homeView() {
    const badge = (id) => {
      const n = id === 'whatsapp' ? Object.values(this.data.unread).reduce((a, b) => a + b, 0) : id === 'uber' && this.request ? 1 : 0;
      return n ? `<i class="badge">${n}</i>` : '';
    };
    const icon = ([id, label]) => `<button class="app-icon" data-app="${id}">${ICONS[id]}${badge(id)}<span>${label}</span></button>`;
    return `<div class="home-grid">${APPS.map(icon).join('')}</div><div class="dock">${DOCK.map(([id]) => `<button class="app-icon" data-app="${id}">${ICONS[id]}${badge(id)}</button>`).join('')}</div>`;
  }

  uberView() {
    const u = this.data.uber;
    const car = ctx.player.vehicle;
    const rating = u.rated ? (u.stars / u.rated).toFixed(2) : '5.00';
    const job = ctx.missions.active;
    let body = '';
    if (job && (job.def.id === 'uber' || job.def.id === 'eats')) {
      body = `<div class="ub-card"><b>${esc(job.def.title)} in progress</b><p>${esc(ctx.missions.objective)}</p><button class="ub-btn danger" data-uber="cancel">Cancel trip</button></div>`;
    } else if (!u.online) {
      body = `<div class="ub-off"><p>You're offline.</p><button class="ub-go" data-uber="online">GO</button></div>`;
    } else if (this.request) {
      const r = this.request;
      body = `<div class="ub-card req">
        <div class="ub-req-top"><b>${r.kind === 'ride' ? 'UberX' : 'Uber Eats'}</b><span>${formatMoney(r.fare)}</span></div>
        <p>${r.kind === 'ride' ? `${esc(r.name)} ★ ${r.rating}` : `${esc(r.restaurant.name)} → ${esc(r.name)}`}</p>
        <p class="muted">Pickup ${Math.round(r.pickDist)} m away · trip ${r.tripKm.toFixed(1)} km · to ${esc(r.dropName)}</p>
        <div class="ub-timer"><i style="width:${(r.ttl / 20) * 100}%"></i></div>
        <div class="ub-row"><button class="ub-btn" data-uber="decline">Decline</button><button class="ub-btn primary" data-uber="accept">Accept</button></div></div>`;
    } else if (!car) {
      body = '<div class="ub-card"><b>Online</b><p>Get into a vehicle to receive requests.</p></div>';
    } else if (u.mode === 'ride' && !canDoUber(car)) {
      body = `<div class="ub-card"><b>Online</b><p>A ${esc(car.label)} can't take Uber rides. Use a normal car, or switch to Eats.</p></div>`;
    } else {
      body = `<div class="ub-card"><b>Finding ${u.mode === 'ride' ? 'riders' : 'orders'}…</b><div class="ub-pulse"></div><p class="muted">Drive around; requests arrive in a few seconds.</p></div>`;
    }
    return `${this.header('Uber', `<span class="ub-rate">★ ${rating}</span>`)}
      <div class="ub-tabs"><button class="${u.mode === 'ride' ? 'on' : ''}" data-uber="mode-ride">Rides</button><button class="${u.mode === 'eats' ? 'on' : ''}" data-uber="mode-eats">Eats</button></div>
      ${body}
      <div class="ub-stats"><div><b>${u.rides}</b><span>rides</span></div><div><b>${u.eats}</b><span>deliveries</span></div><div><b>${formatMoney(u.earned)}</b><span>earned</span></div></div>
      ${u.online ? '<button class="ub-btn wide" data-uber="offline">Go offline</button>' : ''}`;
  }

  instaView() {
    const d = this.data;
    const posts = d.photos.map((p, i) => `<button class="ig-tile" data-photo="${i}"><img src="${p.src}" alt=""><span>❤ ${p.likes}</span></button>`).join('');
    const sel = this.chat != null ? d.photos[this.chat] : null;
    if (sel) {
      return `${this.header('Post')}<div class="ig-post"><div class="ig-user"><i></i><b>frankfurt.skyline</b><span>${esc(sel.place)}</span></div><img src="${sel.src}" alt=""><p><b>❤ ${sel.likes} likes</b></p><p><b>frankfurt.skyline</b> ${esc(sel.caption || '')}</p></div>`;
    }
    return `${this.header('frankfurt.skyline')}
      <div class="ig-prof"><div class="ig-avatar"></div><div><b>${d.photos.length}</b><span>posts</span></div><div><b>${d.followers.toLocaleString('de-DE')}</b><span>followers</span></div><div><b>183</b><span>following</span></div></div>
      <p class="ig-bio"><b>Frankfurt Skyline</b><br>Driving through Mainhattan 🚕🏙️</p>
      <button class="ub-btn wide" data-app="camera">📷 New post</button>
      <div class="ig-grid">${posts || '<p class="muted center">No posts yet. Take a photo of a landmark: landmark posts get more likes and sponsor money.</p>'}</div>`;
  }

  postView() {
    const d = this.draft;
    if (!d) return this.instaView();
    return `${this.header('New post')}<div class="ig-post"><img src="${d.src}" alt=""><p class="muted">📍 ${esc(d.place)}${d.landmark ? ' · landmark bonus' : ''}</p>
      <input class="ig-caption" maxlength="120" placeholder="Write a caption…"><div class="ub-row"><button class="ub-btn" data-post="discard">Discard</button><button class="ub-btn primary" data-post="share">Share</button></div></div>`;
  }

  waView() {
    const d = this.data;
    if (this.chat) {
      const c = CONTACTS[this.chat];
      d.unread[this.chat] = 0;
      const msgs = (d.chats[this.chat] || [])
        .map((m, i) => {
          const actions = m.actions ? `<div class="wa-actions">${m.actions.map((a) => `<button data-wa="${a.id}" data-idx="${i}">${esc(a.label)}</button>`).join('')}</div>` : '';
          return `<div class="wa-msg ${m.from}">${esc(m.text)}${actions}</div>`;
        })
        .join('');
      return `${this.header(`${c.avatar} ${esc(c.name)}`)}<div class="wa-log">${msgs}</div>`;
    }
    const rows = Object.keys(CONTACTS)
      .filter((id) => d.chats[id]?.length)
      .sort((a, b) => d.chats[b].at(-1).t - d.chats[a].at(-1).t)
      .map((id) => {
        const c = CONTACTS[id], last = d.chats[id].at(-1), n = d.unread[id] || 0;
        return `<button class="wa-row" data-chat="${id}"><i>${c.avatar}</i><div><b>${esc(c.name)}</b><span>${esc(last.text)}</span></div>${n ? `<em>${n}</em>` : ''}</button>`;
      })
      .join('');
    return `${this.header('WhatsApp')}<div class="wa-list">${rows || '<p class="muted center">No chats yet.</p>'}</div>`;
  }

  mapsView() {
    const places = [
      ['bus', 'Bus depot'],
      ['taxi', 'Taxi rank'],
      ['van', 'Courier depot'],
      ['tow', 'Tow service'],
      ['ambulance', 'Ambulance station'],
      ['scooter', 'Delivery scooter'],
    ];
    const btns = places.map(([k, l]) => `<button class="map-place" data-place="${k}">${l}</button>`).join('');
    return `${this.header('Maps')}<canvas class="ph-map" width="560" height="460"></canvas><div class="map-places"><button class="map-place strong" data-place="full">Open full map</button>${btns}<button class="map-place" data-place="clear">Clear waypoint</button></div>`;
  }

  drawMap() {
    const cv = this.screen.querySelector('.ph-map');
    if (!cv || !ctx.hud?.minimap) return;
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height, s = 0.9;
    const P = ctx.player.position;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = LAND_COLOR;
    g.fillRect(0, 0, W, H);
    g.save();
    g.translate(W / 2, H / 2);
    g.scale(s, s);
    g.translate(-P.x, -P.z);
    const r = Math.hypot(W, H) / s;
    ctx.hud.minimap.renderer.drawBase(g, s, { minx: P.x - r, maxx: P.x + r, minz: P.z - r, maxz: P.z + r }, true);
    g.restore();
    for (const b of ctx.blips.list.values()) {
      const x = W / 2 + (b.x - P.x) * s, y = H / 2 + (b.z - P.z) * s;
      if (x > 8 && y > 8 && x < W - 8 && y < H - 8) drawBlip(g, b.type, x, y, 20);
    }
    const heading = ctx.player.vehicle ? ctx.player.vehicle.yaw : ctx.player.yaw;
    drawBlip(g, 'player', W / 2, H / 2, 24, { rotation: Math.PI - heading });
  }

  bankView() {
    const rows = this.data.transactions
      .map((t) => {
        const when = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t.t));
        return `<div class="bk-row"><div><b>${esc(t.reason)}</b><span>${when}</span></div><em class="${t.amount >= 0 ? 'pos' : 'neg'}">${t.amount >= 0 ? '+' : '−'}${formatMoney(Math.abs(t.amount))}</em></div>`;
      })
      .join('');
    return `${this.header('Bank')}<div class="bk-card"><span>Girokonto</span><b>${formatMoney(ctx.player.money)}</b><small>DE89 5005 0000 •••• 2026</small></div><div class="bk-list">${rows || '<p class="muted center">No transactions yet.</p>'}</div>`;
  }

  settingsView() {
    const d = this.data;
    return `${this.header('Settings')}<div class="st-list">
      <label class="st-row">Notifications<button class="toggle ${d.notifications ? 'on' : ''}" data-set="notifications"></button></label>
      <label class="st-row">Volume<input type="range" min="0" max="1" step="0.05" value="${settings.get('masterVolume')}" data-set="volume"></label>
      <div class="st-row">Wallpaper<div class="st-walls">${WALLPAPERS.map((w, i) => `<button style="background:${w}" class="${i === d.wallpaper ? 'on' : ''}" data-wall="${i}"></button>`).join('')}</div></div>
      <button class="st-row link" data-set="game">Game settings ›</button>
      <button class="st-row link" data-set="save">Save game ›</button></div>`;
  }

  onClick(e) {
    const t = e.target.closest('button, input');
    if (!t) return;
    const ds = t.dataset;
    if ('back' in ds) return this.back();
    if (ds.app) return this.go(ds.app);
    if (ds.uber) {
      const u = this.data.uber;
      if (ds.uber === 'online') u.online = true;
      else if (ds.uber === 'offline') {
        u.online = false;
        this.request = null;
      } else if (ds.uber === 'accept') return this.acceptRequest();
      else if (ds.uber === 'decline') this.request = null;
      else if (ds.uber === 'cancel') ctx.missions.end(false, 'Trip cancelled');
      else if (ds.uber.startsWith('mode-')) {
        u.mode = ds.uber.slice(5);
        this.request = null;
      }
      this.reqTimer = Math.min(this.reqTimer, 6);
      return this.render();
    }
    if (ds.photo != null) {
      this.chat = Number(ds.photo);
      return this.render();
    }
    if (ds.post === 'share') return this.post();
    if (ds.post === 'discard') {
      this.draft = null;
      return this.go('instagram');
    }
    if (ds.chat) {
      this.chat = ds.chat;
      return this.render();
    }
    if (ds.wa) return this.onAction(this.chat, Number(ds.idx), ds.wa);
    if (ds.place) {
      if (ds.place === 'full') {
        this.setOpen(false);
        return ctx.menus.openPause('map');
      }
      if (ds.place === 'clear') ctx.map.clearWaypoint();
      else {
        const d = ctx.depots.nearest(ds.place);
        if (d) ctx.map.setWaypoint(d.x, d.z);
      }
      return this.drawMap();
    }
    if (ds.set === 'notifications') {
      this.data.notifications = !this.data.notifications;
      return this.render();
    }
    if (ds.set === 'game') {
      this.setOpen(false);
      return ctx.menus.openPause('settings');
    }
    if (ds.set === 'save') {
      this.setOpen(false);
      return ctx.menus.openSave(false);
    }
    if (ds.wall != null) {
      this.data.wallpaper = Number(ds.wall);
      return this.render();
    }
  }

  /** Volume slider (input events). */
  bindInputs() {
    this.screen.addEventListener('input', (e) => {
      if (e.target.dataset.set === 'volume') settings.set('masterVolume', parseFloat(e.target.value));
    });
  }

  serialize() {
    return { ...this.data };
  }
  restore(data) {
    this.data = { ...Phone.empty(), ...(data || {}), uber: { ...Phone.empty().uber, ...(data?.uber || {}), online: false } };
    this.request = null;
    this.draft = null;
  }
}

