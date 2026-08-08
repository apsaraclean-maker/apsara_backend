import { DateTime } from 'luxon';
// This is an India-only business — "today"/"this month" must be calendar boundaries in
// IST (UTC+5:30), not UTC. Using .toUTC() for these previously meant the day rolled over
// at 5:30am IST instead of midnight IST: an order placed at 1am IST would be counted as
// belonging to the *previous* calendar day everywhere (order numbers, Dashboard's "today"
// stats, the Timeline's "today" column, Branch Card's "this month" revenue, Reports'
// daily/weekly/monthly windows). Storage stays UTC ISO strings throughout — only the
// boundary itself needs to be computed in IST, then converted back to UTC for querying/
// display consistency with the rest of the app.
export const BUSINESS_TIMEZONE = 'Asia/Kolkata';
// "Now," expressed in IST, for computing IST-calendar-day/month boundaries.
export function nowInBusinessTz() {
    return DateTime.now().setZone(BUSINESS_TIMEZONE);
}
// Parses a plain date string (e.g. "2026-07-20", as sent by frontend date pickers) as an
// IST calendar date rather than whatever the server process's default zone happens to be.
export function parseDateInBusinessTz(iso) {
    return DateTime.fromISO(iso, { zone: BUSINESS_TIMEZONE });
}
// Formats a stored UTC timestamp as its IST calendar date (yyyy-MM-dd). Plain
// `DateTime.fromISO(utcString).toFormat(...)` silently depends on the server process's
// system-default timezone (Luxon's defaultZone) unless a zone is set explicitly — fragile,
// since that's whatever the deployment host happens to be configured with, not necessarily
// IST or even UTC.
//
// Accepts a Date (what the schema stores now) or an ISO string (what aggregation output and
// any not-yet-migrated row can still hand back).
export function toBusinessDateString(utc) {
    const dt = utc instanceof Date ? DateTime.fromJSDate(utc) : DateTime.fromISO(utc);
    return dt.setZone(BUSINESS_TIMEZONE).toFormat('yyyy-MM-dd');
}
// Mongo's $dateToString does this same IST-calendar-day bucketing inside the aggregation
// pipeline, which is where it belongs now that timestamps are real Dates — the Timeline used
// to pull every matching row back into Node purely to call toBusinessDateString on each one.
export const BUSINESS_TZ_DATE_STRING = (field) => ({
    $dateToString: { format: '%Y-%m-%d', date: field, timezone: BUSINESS_TIMEZONE },
});
