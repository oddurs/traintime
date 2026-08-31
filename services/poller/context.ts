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

export { band, daypart, season, isHoliday, calendarRow, type WeatherBand } from "../../src/lib/calendar";
import { band, calendarRow } from "../../src/lib/calendar";

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
