/**
 * Dates as the team reads them: always day/month/year (dd/mm/aaaa), whatever
 * the computer's language or region. Times are 24 h (HH:mm).
 */

const pad = (n: number) => n.toString().padStart(2, "0");

/** 15/10/2026 */
export function formatDayMonthYear(date: Date): string {
  if (isNaN(date.getTime())) return "";
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** 15/10/2026 13:50 */
export function formatDayMonthYearTime(date: Date): string {
  if (isNaN(date.getTime())) return "";
  return `${formatDayMonthYear(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Unix seconds → 15/10/2026 13:50 */
export function formatUnixSeconds(seconds: number): string {
  return formatDayMonthYearTime(new Date(seconds * 1000));
}

/** "2026-10-15" (or an ISO datetime) → "15/10/2026"; "" when not a date. */
export function isoToDayMonthYear(value: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

/**
 * What the user typed as day/month/year → "YYYY-MM-DD".
 * Accepts "15/10/2026", "15-10-2026", "15.10.2026" and a 2-digit year.
 * Returns "" for an empty field and null when it is not a real date.
 */
export function dayMonthYearToIso(text: string): string | null {
  const value = text.trim();
  if (!value) return "";
  const match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(value);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year =
    match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}
