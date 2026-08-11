// Fixed Philippine-time formatting for signal timestamps.
//
// Database timestamps stay UTC `timestamptz`; only PRESENTATION converts to
// the fixed IANA zone Asia/Manila (UTC+08:00, no DST), independent of the
// browser's locale or timezone settings. The visible format always ends in
// "PHT" and an accessible tooltip exposes the canonical UTC ISO timestamp.

export const PHT_TIME_ZONE = "Asia/Manila";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PHT_TIME_ZONE,
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

function validDate(value: string | Date): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function formatPhtTimestamp(value: string | Date): string {
  const date = validDate(value);
  if (!date) return "Invalid timestamp";
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year} · ${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod} PHT`;
}

export function utcIsoTitle(value: string | Date): string {
  return validDate(value)?.toISOString() ?? "Invalid timestamp";
}
