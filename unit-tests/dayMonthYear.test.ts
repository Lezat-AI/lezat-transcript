import { describe, expect, test } from "bun:test";
import {
  dayMonthYearToIso,
  formatDayMonthYear,
  formatDayMonthYearTime,
  isoToDayMonthYear,
} from "../src/utils/dayMonthYear";
import { formatDate } from "../src/components/action-items/shared";

describe("dates are always day/month/year", () => {
  test("formats a date and a date with time", () => {
    const date = new Date(2026, 9, 5, 9, 7);
    expect(formatDayMonthYear(date)).toBe("05/10/2026");
    expect(formatDayMonthYearTime(date)).toBe("05/10/2026 09:07");
  });

  test("ISO dates from the server", () => {
    expect(isoToDayMonthYear("2026-10-24")).toBe("24/10/2026");
    expect(isoToDayMonthYear("2026-10-24T15:00:00Z")).toBe("24/10/2026");
    expect(isoToDayMonthYear(null)).toBe("");
    expect(formatDate("2026-10-01")).toBe("01/10/2026");
  });

  test("what the user types becomes YYYY-MM-DD", () => {
    expect(dayMonthYearToIso("24/10/2026")).toBe("2026-10-24");
    expect(dayMonthYearToIso("5/1/26")).toBe("2026-01-05");
    expect(dayMonthYearToIso("24-10-2026")).toBe("2026-10-24");
    expect(dayMonthYearToIso("")).toBe("");
  });

  test("impossible or month-first dates are rejected", () => {
    expect(dayMonthYearToIso("31/02/2026")).toBeNull();
    expect(dayMonthYearToIso("10/24/2026")).toBeNull();
    expect(dayMonthYearToIso("mañana")).toBeNull();
  });
});
