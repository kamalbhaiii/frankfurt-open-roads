/**
 * Safe wrapper around localStorage. Storage can be unavailable (private mode,
 * blocked site data, sandboxed previews), so every call is guarded and the game
 * keeps working without persistence.
 */
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
