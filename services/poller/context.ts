/**
 * Context recording: weather and the calendar, hour by hour.
 *
 * A run time is not a property of a stretch of track alone — it is a property of that track at
 * that hour, on that kind of day, in that weather. None of that can be backfilled: if we are not
 * recording the weather now, no future model can ever condition on it. So this starts on the
 * first boot and simply keeps a row per hour, ready to be joined against whenever the modelling
 * is ready for it.
 */
import { DuckDBConnection } from "@duckdb/node-api";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { REC_DIR } from "./recorder";

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const NYC = { lat: 40.7527, lon: -73.9772 };

export const CONTEXT_SCHEMA = `
CREATE TABLE IF NOT EXISTS weather (
  hour BIGINT, observed_at BIGINT, temp_c DOUBLE, feels_c DOUBLE, humidity DOUBLE,
  precip_mm DOUBLE, rain_mm DOUBLE, snow_cm DOUBLE, wind_kph DOUBLE, gust_kph DOUBLE, code INTEGER
);
CREATE TABLE IF NOT EXISTS calendar (
  hour BIGINT, ny_date VARCHAR, hour_of_day SMALLINT, day_of_week SMALLINT, hour_of_week SMALLINT,
  month SMALLINT, daypart VARCHAR, is_weekend BOOLEAN, is_holiday BOOLEAN, season VARCHAR
);
`;

/** WMO weather codes collapsed to the bands that plausibly change how a subway runs. */
export type WeatherBand = "clear" | "cloud" | "rain" | "heavy-rain" | "snow" | "extreme";

export function band(w: { precip_mm: number; snow_cm: number; code: number }): WeatherBand {
  if (w.snow_cm > 0.1 || (w.code >= 71 && w.code <= 77) || w.code === 85 || w.code === 86) return "snow";
  if (w.code >= 95) return "extreme";
  if (w.precip_mm >= 2.5) return "heavy-rain";
  if (w.precip_mm > 0 || (w.code >= 51 && w.code <= 67) || (w.code >= 80 && w.code <= 82)) return "rain";
  if (w.code >= 2) return "cloud";
  return "clear";
}

/** Rush hours are the point of this: dwell and run times differ most between these. */
export function daypart(hourOfDay: number, weekend: boolean): string {
  if (hourOfDay < 5) return "owl";
  if (weekend) return hourOfDay < 12 ? "weekend-am" : hourOfDay < 20 ? "weekend-pm" : "evening";
  if (hourOfDay < 10) return "am-peak";
  if (hourOfDay < 16) return "midday";
  if (hourOfDay < 20) return "pm-peak";
  return "evening";
}

export function season(month: number): string {
  if (month === 7 || month === 8) return "summer";        // school out, lighter loads
  if (month === 12 || month <= 2) return "winter";
  return "school";
}

/** Federal holidays plus the days the system visibly runs a lighter service. */
const FIXED_HOLIDAYS = new Set(["01-01", "06-19", "07-04", "11-11", "12-25", "12-24", "12-31"]);
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}
function lastWeekday(y: number, m: number, weekday: number): number {
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = new Date(Date.UTC(y, m - 1, days)).getUTCDay();
  return days - ((last - weekday + 7) % 7);
}
export function isHoliday(y: number, m: number, d: number): boolean {
  const md = `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (FIXED_HOLIDAYS.has(md)) return true;
  if (m === 1 && d === nthWeekday(y, 1, 1, 3)) return true;   // MLK
  if (m === 2 && d === nthWeekday(y, 2, 1, 3)) return true;   // Presidents'
  if (m === 5 && d === lastWeekday(y, 5, 1)) return true;     // Memorial
  if (m === 9 && d === nthWeekday(y, 9, 1, 1)) return true;   // Labor
  if (m === 10 && d === nthWeekday(y, 10, 1, 2)) return true; // Indigenous Peoples'
  if (m === 11 && d === nthWeekday(y, 11, 4, 4)) return true; // Thanksgiving
  return false;
}

const nyParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hour12: false,
});
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function calendarRow(epochSec: number) {
  const parts = nyParts.formatToParts(new Date(epochSec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const year = Number(get("year")), month = Number(get("month")), day = Number(get("day"));
  const hourOfDay = Number(get("hour")) % 24;
  const dow = DOW[get("weekday")] ?? 0;
  const weekend = dow === 0 || dow === 6;
  const holiday = isHoliday(year, month, day);
  return {
    hour: Math.floor(epochSec / 3600) * 3600,
    ny_date: `${get("year")}-${get("month")}-${get("day")}`,
    hour_of_day: hourOfDay,
    day_of_week: dow,
    // 168 buckets: the natural unit for a transit timetable, capturing weekday and rush together.
    hour_of_week: dow * 24 + hourOfDay,
    month,
    // A holiday runs weekend-ish service even midweek, so it is treated as one.
    daypart: daypart(hourOfDay, weekend || holiday),
    is_weekend: weekend,
    is_holiday: holiday,
    season: season(month),
  };
}

export interface WeatherNow {
  hour: number; observed_at: number; temp_c: number; feels_c: number; humidity: number;
  precip_mm: number; rain_mm: number; snow_cm: number; wind_kph: number; gust_kph: number; code: number;
}

export async function fetchWeather(signal?: AbortSignal): Promise<WeatherNow | null> {
  const url = `${OPEN_METEO}?latitude=${NYC.lat}&longitude=${NYC.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,wind_speed_10m,wind_gusts_10m&timezone=America%2FNew_York`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: signal ?? AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { current?: Record<string, number> };
    const c = j.current;
    if (!c) return null;
    const now = Math.floor(Date.now() / 1000);
    return {
      hour: Math.floor(now / 3600) * 3600, observed_at: now,
      temp_c: c.temperature_2m ?? 0, feels_c: c.apparent_temperature ?? 0, humidity: c.relative_humidity_2m ?? 0,
      precip_mm: c.precipitation ?? 0, rain_mm: c.rain ?? 0, snow_cm: c.snowfall ?? 0,
      wind_kph: c.wind_speed_10m ?? 0, gust_kph: c.wind_gusts_10m ?? 0, code: c.weather_code ?? 0,
    };
  } catch {
    return null;
  }
}

/** Records one weather and one calendar row per hour, into their own Parquet tables. */
export class ContextRecorder {
  private lastHour = 0;
  latest: WeatherNow | null = null;
  errors = 0;

  constructor(private readonly conn: DuckDBConnection) {}

  async init() {
    await this.conn.run(CONTEXT_SCHEMA);
    for (const t of ["weather", "calendar"]) mkdirSync(join(REC_DIR, t), { recursive: true });
  }

  /** Called on a timer; writes at most one row per clock hour. */
  async tick(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const hour = Math.floor(now / 3600) * 3600;
    if (hour === this.lastHour) return false;
    const w = await fetchWeather();
    if (!w) { this.errors++; return false; }
    this.latest = w;
    this.lastHour = hour;

    const wa = await this.conn.createAppender("weather");
    wa.appendBigInt(BigInt(w.hour)); wa.appendBigInt(BigInt(w.observed_at));
    for (const v of [w.temp_c, w.feels_c, w.humidity, w.precip_mm, w.rain_mm, w.snow_cm, w.wind_kph, w.gust_kph]) wa.appendDouble(v);
    wa.appendInteger(w.code);
    wa.endRow();
    wa.closeSync();

    const c = calendarRow(now);
    const ca = await this.conn.createAppender("calendar");
    ca.appendBigInt(BigInt(c.hour)); ca.appendVarchar(c.ny_date);
    ca.appendSmallInt(c.hour_of_day); ca.appendSmallInt(c.day_of_week); ca.appendSmallInt(c.hour_of_week);
    ca.appendSmallInt(c.month); ca.appendVarchar(c.daypart);
    ca.appendBoolean(c.is_weekend); ca.appendBoolean(c.is_holiday); ca.appendVarchar(c.season);
    ca.endRow();
    ca.closeSync();
    return true;
  }

  status() {
    return this.latest
      ? { hour: this.latest.hour, band: band(this.latest), tempC: this.latest.temp_c, precipMm: this.latest.precip_mm, errors: this.errors }
      : { hour: 0, band: null, errors: this.errors };
  }
}
