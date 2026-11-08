/**
 * Unified input: keyboard (rebindable actions), mouse look, touch controls and gamepads.
 *
 * Gameplay code reads:
 *   input.down(action)     – held this frame
 *   input.pressed(action)  – went down since the last endFrame()
 *   input.axes()           – {f, r} movement in [-1, 1]
 *   input.takeLook()       – accumulated look delta (radians) since the last call
 */
import { settings } from './settings.js';
import { clamp } from './math.js';

const GAMEPAD_BUTTONS = {
  jump: [0], // A
  vehicle: [3], // Y
  sprint: [2], // X
  horn: [10], // L3
  lookBehind: [11], // R3
  camera: [12], // d-pad up
  radio: [15], // d-pad right
  job: [14], // d-pad left
  unstuck: [13], // d-pad down
  map: [8], // back/view
  pause: [9], // start/menu
  phone: [5], // RB
};

class Input {
  constructor() {
    this.codes = new Set();
    this.virtual = new Set(); // actions held by touch buttons
    this.edges = new Set();
    this.look = { x: 0, y: 0 };
    this.touchMove = { x: 0, y: 0, active: false };
    this.pad = { f: 0, r: 0, lx: 0, ly: 0, buttons: new Set(), connected: false };
    this.capture = null;
    this.enabled = false;
    this.isTouch = false;
    this.pointerLocked = false;
    this.lastLookInput = 0;
    this.wheel = 0;
  }

  attach(canvas) {
    this.canvas = canvas;
    addEventListener('keydown', (e) => {
      if (this.capture) {
        e.preventDefault();
        const cb = this.capture;
        this.capture = null;
        cb(e.code === 'Escape' ? null : e.code);
        return;
      }
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) {
        if (e.target === document.body || e.target === canvas) e.preventDefault();
      }
      if (!this.codes.has(e.code)) {
        for (const a of this.actionsFor(e.code)) this.edges.add(a);
      }
      this.codes.add(e.code);
    });
    addEventListener('keyup', (e) => this.codes.delete(e.code));
    addEventListener('blur', () => this.codes.clear());

    canvas.addEventListener('mousedown', () => {
      if (this.enabled && !this.isTouch && document.pointerLockElement !== canvas) this.lockPointer();
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') drag = [e.clientX, e.clientY];
    });
    addEventListener('pointerup', () => (drag = null));
    addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      const sens = settings.get('mouseSensitivity');
      if (this.pointerLocked) this.addLook(e.movementX * 0.0025 * sens, e.movementY * 0.0022 * sens);
      else if (drag) {
        this.addLook((e.clientX - drag[0]) * 0.005 * sens, (e.clientY - drag[1]) * 0.004 * sens);
        drag = [e.clientX, e.clientY];
      }
    });
    canvas.addEventListener('wheel', (e) => (this.wheel += e.deltaY), { passive: true });
    addEventListener('gamepadconnected', () => (this.pad.connected = true));
    addEventListener('gamepaddisconnected', () => (this.pad.connected = false));
  }

  lockPointer() {
    try {
      const r = this.canvas.requestPointerLock();
      if (r && r.catch) r.catch(() => {});
    } catch {
      /* pointer lock unavailable (iframe/preview) – drag-to-look still works */
    }
  }
  unlockPointer() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  addLook(dx, dy) {
    this.look.x += dx;
    this.look.y += dy * (settings.get('invertY') ? -1 : 1);
    this.lastLookInput = performance.now();
  }
  takeLook() {
    const l = { x: this.look.x, y: this.look.y };
    this.look.x = this.look.y = 0;
    return l;
  }
  takeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  actionsFor(code) {
    const out = [];
    const b = settings.get('bindings');
    for (const a in b) if (b[a].includes(code)) out.push(a);
    return out;
  }
  down(action) {
    if (this.virtual.has(action) || this.pad.buttons.has(action)) return true;
    const codes = settings.get('bindings')[action];
    return !!codes && codes.some((c) => c && this.codes.has(c));
  }
  pressed(action) {
    return this.edges.has(action);
  }
  /** Simulates an action press (touch buttons, UI). */
  trigger(action) {
    this.edges.add(action);
  }
  hold(action, on) {
    if (on) {
      if (!this.virtual.has(action)) this.edges.add(action);
      this.virtual.add(action);
    } else this.virtual.delete(action);
  }
  axes() {
    let f = (this.down('forward') ? 1 : 0) - (this.down('back') ? 1 : 0);
    let r = (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0);
    if (this.touchMove.active) {
      f = -this.touchMove.y;
      r = this.touchMove.x;
    }
    if (Math.abs(this.pad.f) > 0.15 || Math.abs(this.pad.r) > 0.15) {
      f = this.pad.f;
      r = this.pad.r;
    }
    return { f: clamp(f, -1, 1), r: clamp(r, -1, 1) };
  }
  /** Captures the next key press for rebinding; cb(code|null). */
  captureNext(cb) {
    this.capture = cb;
  }

  /** Polls gamepads; call once per rendered frame. */
  pollGamepad(dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find((p) => p && p.connected);
    const prev = this.pad.buttons;
    const now = new Set();
    if (!gp) {
      this.pad.f = this.pad.r = 0;
      this.pad.buttons = now;
      return;
    }
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
    const rt = gp.buttons[7]?.value || 0,
      lt = gp.buttons[6]?.value || 0;
    const ly = dz(gp.axes[1] || 0);
    this.pad.f = rt > 0.05 || lt > 0.05 ? rt - lt : -ly;
    this.pad.r = dz(gp.axes[0] || 0);
    const rx = dz(gp.axes[2] || 0),
      ry = dz(gp.axes[3] || 0);
    if (rx || ry) this.addLook(rx * 2.6 * dt * settings.get('mouseSensitivity'), ry * 1.8 * dt * settings.get('mouseSensitivity'));
    for (const a in GAMEPAD_BUTTONS) if (GAMEPAD_BUTTONS[a].some((i) => gp.buttons[i]?.pressed)) now.add(a);
    if (lt > 0.5 && rt < 0.05) now.add('back');
    for (const a of now) if (!prev.has(a)) this.edges.add(a);
    this.pad.buttons = now;
    this.pad.connected = true;
  }

  endFrame() {
    this.edges.clear();
  }

  /** Builds the on-screen joystick and buttons for touch devices. */
  setupTouch(root) {
    this.isTouch = true;
    root.style.display = 'block';
    const joy = root.querySelector('#joy'),
      knob = root.querySelector('#knob');
    const t = { move: null, lookId: null, ox: 0, oy: 0, lx: 0, ly: 0 };
    const cv = this.canvas;
    cv.addEventListener(
      'touchstart',
      (e) => {
        for (const p of e.changedTouches) {
          if (p.clientX < innerWidth * 0.45 && t.move === null) {
            t.move = p.identifier;
            t.ox = p.clientX;
            t.oy = p.clientY;
            joy.style.left = `${p.clientX - 60}px`;
            joy.style.top = `${p.clientY - 60}px`;
            joy.style.opacity = 1;
            this.touchMove.active = true;
          } else if (t.lookId === null) {
            t.lookId = p.identifier;
            t.lx = p.clientX;
            t.ly = p.clientY;
          }
        }
      },
      { passive: false },
    );
    cv.addEventListener(
      'touchmove',
      (e) => {
        for (const p of e.changedTouches) {
          if (p.identifier === t.move) {
            const dx = clamp((p.clientX - t.ox) / 50, -1, 1),
              dy = clamp((p.clientY - t.oy) / 50, -1, 1);
            this.touchMove.x = dx;
            this.touchMove.y = dy;
            knob.style.transform = `translate(${dx * 40}px,${dy * 40}px)`;
          }
          if (p.identifier === t.lookId) {
            const s = settings.get('mouseSensitivity');
            this.addLook((p.clientX - t.lx) * 0.006 * s, (p.clientY - t.ly) * 0.004 * s);
            t.lx = p.clientX;
            t.ly = p.clientY;
          }
        }
        e.preventDefault();
      },
      { passive: false },
    );
    const end = (e) => {
      for (const p of e.changedTouches) {
        if (p.identifier === t.move) {
          t.move = null;
          this.touchMove = { x: 0, y: 0, active: false };
          knob.style.transform = '';
          joy.style.opacity = 0.35;
        }
        if (p.identifier === t.lookId) t.lookId = null;
      }
    };
    cv.addEventListener('touchend', end);
    cv.addEventListener('touchcancel', end);
    for (const b of root.querySelectorAll('[data-action]')) {
      const action = b.dataset.action;
      b.addEventListener(
        'touchstart',
        (e) => {
          e.preventDefault();
          this.hold(action, true);
        },
        { passive: false },
      );
      b.addEventListener('touchend', (e) => {
        e.preventDefault();
        this.hold(action, false);
      });
    }
  }
}

export const input = new Input();
