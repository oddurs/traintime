import { test } from "node:test";
import assert from "node:assert/strict";
import { stampTime } from "../services/poller/retention";
import { band, calendarRow, daypart, isHoliday, season } from "../services/poller/context";

test("retention: file stamps parse strictly", () => {
  const at = (f: string) => (stampTime(f) === null ? null : new Date(stampTime(f)!).toISOString());
  assert.equal(at("2026-08-31T00-19-44.parquet"), "2026-08-31T00:19:44.000Z");
  // The bug this guards: a loose conversion reads "2026-08-31" as 1 January at 08:31, which
  // made pruning delete the file compaction had just written.
  assert.equal(at("daily-2026-08-31.parquet"), "2026-08-31T00:00:00.000Z");
  assert.equal(at("rebuilt-2026-08-31T02-19-52.parquet"), "2026-08-31T02:19:52.000Z");
  assert.equal(stampTime("nonsense.parquet"), null);
});

test("calendar: hour-of-week is New York local, across both DST transitions", () => {
  // 2026-03-08 is the spring forward; 09:30 UTC is 04:30 EST before, 05:30 EDT after.
  const beforeSpring = calendarRow(Date.UTC(2026, 2, 8, 6, 30) / 1000);   // 01:30 EST
  assert.equal(beforeSpring.hour_of_day, 1);
  const afterSpring = calendarRow(Date.UTC(2026, 2, 8, 8, 30) / 1000);    // 04:30 EDT
  assert.equal(afterSpring.hour_of_day, 4);

  // 2026-11-01 is the fall back; 05:30 UTC is 01:30 EDT, 06:30 UTC is 01:30 EST again.
  assert.equal(calendarRow(Date.UTC(2026, 10, 1, 5, 30) / 1000).hour_of_day, 1);
  assert.equal(calendarRow(Date.UTC(2026, 10, 1, 6, 30) / 1000).hour_of_day, 1);

  // Sunday is day 0, so hour-of-week stays inside 0..167. This instant is after the fall-back,
  // so 17:00 UTC is noon EST rather than 13:00 EDT.
  const sunday = calendarRow(Date.UTC(2026, 10, 1, 17, 0) / 1000);
  assert.equal(sunday.day_of_week, 0);
  assert.equal(sunday.hour_of_day, 12);
  assert.equal(sunday.hour_of_week, 12);
  assert.ok(sunday.is_weekend);
});

test("calendar: dayparts split the peaks", () => {
  assert.equal(daypart(3, false), "owl");
  assert.equal(daypart(8, false), "am-peak");
  assert.equal(daypart(13, false), "midday");
  assert.equal(daypart(18, false), "pm-peak");
  assert.equal(daypart(22, false), "evening");
  // A weekend morning is not a rush hour.
  assert.equal(daypart(8, true), "weekend-am");
});

test("calendar: holidays run weekend-shaped service", () => {
  assert.ok(isHoliday(2026, 7, 4));
  assert.ok(isHoliday(2026, 11, 26), "Thanksgiving is the fourth Thursday");
  assert.ok(isHoliday(2026, 5, 25), "Memorial Day is the last Monday in May");
  assert.ok(!isHoliday(2026, 8, 31));
  // A midweek holiday is treated as a weekend for the purposes of dayparts.
  const july4 = calendarRow(Date.UTC(2026, 6, 4, 13, 0) / 1000);
  assert.ok(july4.is_holiday);
  assert.ok(july4.daypart.startsWith("weekend"));
});

test("calendar: seasons follow the school year", () => {
  assert.equal(season(7), "summer");
  assert.equal(season(1), "winter");
  assert.equal(season(10), "school");
});

test("weather: codes collapse to bands that could change how trains run", () => {
  assert.equal(band({ precip_mm: 0, snow_cm: 0, code: 0 }), "clear");
  assert.equal(band({ precip_mm: 0, snow_cm: 0, code: 3 }), "cloud");
  assert.equal(band({ precip_mm: 0.4, snow_cm: 0, code: 61 }), "rain");
  assert.equal(band({ precip_mm: 6, snow_cm: 0, code: 65 }), "heavy-rain");
  assert.equal(band({ precip_mm: 1, snow_cm: 2, code: 73 }), "snow");
  assert.equal(band({ precip_mm: 8, snow_cm: 0, code: 95 }), "extreme");
});
