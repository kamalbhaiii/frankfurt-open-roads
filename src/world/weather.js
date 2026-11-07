/**
 * Live Frankfurt weather (DWD via Bright Sky, then Open-Meteo), with a plausible
 * date-seeded fallback when the network is blocked, plus manual presets.
 */
import { LAT, LON } from '../core/config.js';
import { clamp, hash } from '../core/math.js';

export const PRESETS = {
  clear: { cloud: 0.05, rain: 0, snow: 0, fog: 0.08, storm: 0, wind: 2, label: 'Clear' },
  cloudy: { cloud: 0.85, rain: 0, snow: 0, fog: 0.2, storm: 0, wind: 4, label: 'Overcast' },
  rain: { cloud: 0.95, rain: 0.75, snow: 0, fog: 0.35, storm: 0, wind: 6, label: 'Rain' },
  storm: { cloud: 1, rain: 1, snow: 0, fog: 0.45, storm: 1, wind: 12, label: 'Thunderstorm' },
  snow: { cloud: 0.9, rain: 0, snow: 0.8, fog: 0.4, storm: 0, wind: 3, label: 'Snow' },
  fog: { cloud: 0.7, rain: 0, snow: 0, fog: 0.95, storm: 0, wind: 1, label: 'Fog' },
};

const WMO = (c) =>
  c === 0
    ? 'Clear'
    : c <= 2
      ? 'Partly cloudy'
      : c === 3
        ? 'Overcast'
        : c <= 48
          ? 'Fog'
          : c <= 57
            ? 'Drizzle'
            : c <= 67
              ? 'Rain'
              : c <= 77
                ? 'Snow'
                : c <= 82
                  ? 'Showers'
                  : c <= 86
                    ? 'Snow showers'
                    : 'Thunderstorm';

async function fetchJSON(url, ms = 7000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function brightSky() {
  const j = await fetchJSON(`https://api.brightsky.dev/current_weather?lat=${LAT}&lon=${LON}`);
  const w = j.weather;
  const cond = w.condition || 'dry';
  const precip = w.precipitation_60 ?? (w.precipitation_10 ?? 0) * 6;
  const cc = w.cloud_cover ?? 50;
  return {
    cloud: cc / 100,
    temp: w.temperature,
    wind: (w.wind_speed_10 ?? w.wind_speed_30 ?? 10) / 3.6,
    windDir: w.wind_direction_10 ?? w.wind_direction_30 ?? 240,
    rain: ['rain', 'sleet', 'thunderstorm', 'hail'].includes(cond) ? clamp(0.35 + precip / 4, 0.35, 1) : 0,
    snow: cond === 'snow' || cond === 'sleet' ? clamp(0.4 + precip / 3, 0.4, 1) : 0,
    storm: cond === 'thunderstorm' ? 1 : 0,
    fog: cond === 'fog' ? 0.9 : w.visibility ? clamp(1 - w.visibility / 30000, 0, 0.8) : 0.15,
    label: cond === 'dry' ? (cc > 80 ? 'Overcast' : cc > 35 ? 'Partly cloudy' : 'Clear') : cond[0].toUpperCase() + cond.slice(1),
    source: 'Live · DWD via Bright Sky',
  };
}

async function openMeteo() {
  const j = await fetchJSON(
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,precipitation,visibility`,
  );
  const c = j.current;
  const code = c.weather_code;
  return {
    cloud: c.cloud_cover / 100,
    temp: c.temperature_2m,
    wind: c.wind_speed_10m / 3.6,
    windDir: c.wind_direction_10m,
    rain: (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95 ? clamp(0.35 + c.precipitation / 3, 0.35, 1) : 0,
    snow: (code >= 71 && code <= 77) || code === 85 || code === 86 ? 0.7 : 0,
    storm: code >= 95 ? 1 : 0,
    fog: code === 45 || code === 48 ? 0.9 : c.visibility ? clamp(1 - c.visibility / 30000, 0, 0.8) : 0.15,
    label: WMO(code),
    source: 'Live · Open-Meteo',
  };
}

/** Plausible Frankfurt weather for today's date when no live feed is reachable. */
function simulated() {
  const d = new Date();
  const day = Math.floor(d.getTime() / 864e5);
  const r = hash(day),
    r2 = hash(day + 0.3);
  const month = d.getMonth();
  const cold = month >= 10 || month <= 2;
  const cloud = clamp(r * 1.1, 0, 1);
  const wet = r2 < (cold ? 0.4 : 0.25) && cloud > 0.5;
  const temp = [2, 3, 7, 11, 15, 19, 21, 20, 16, 11, 6, 3][month] + (r - 0.5) * 6;
  return {
    cloud,
    temp,
    wind: 2 + r2 * 6,
    windDir: 240,
    rain: wet && temp > 1 ? 0.5 : 0,
    snow: wet && temp <= 1 ? 0.6 : 0,
    storm: 0,
    fog: cold && r2 > 0.8 ? 0.7 : 0.15,
    label: wet ? (temp <= 1 ? 'Snow' : 'Rain') : cloud > 0.8 ? 'Overcast' : cloud > 0.35 ? 'Partly cloudy' : 'Clear',
    source: 'Simulated (live feed unavailable)',
  };
}

/** Returns live weather, trying each provider in turn. Never throws. */
export async function fetchLiveWeather() {
  for (const provider of [brightSky, openMeteo]) {
    try {
      return await provider();
    } catch {
      /* try the next provider */
    }
  }
  return simulated();
}
