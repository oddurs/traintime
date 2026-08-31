/**
 * Calendar and weather context, shared by the recorder that writes it and the model that
 * conditions on it. Pure functions only: no I/O, so the browser can use them too.
 */

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

