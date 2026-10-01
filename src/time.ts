type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Calendar day (YYYY-MM-DD) in a time zone. */
export function zonedDay(date: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Calendar day (YYYY-MM-DD) in UTC. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant when the wall clock of a time zone shows the given local date and time. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall - offsetMs(new Date(wall), timeZone);
  // A second pass settles instants near a daylight saving change.
  guess = wall - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/**
 * The slot in progress: the latest slot start at or before now, today or yesterday in the slot time zone.
 * Missed slots are never stacked: only this one counts.
 */
export function currentSlot(now: Date, slots: readonly string[], timeZone: string): Date {
  const today = zonedParts(now, timeZone);
  let latest: Date | undefined;
  for (const dayOffset of [0, -1]) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
    for (const slot of slots) {
      const [hour, minute] = slot.split(':').map(Number) as [number, number];
      const start = zonedTimeToUtc(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        hour,
        minute,
        timeZone,
      );
      if (start <= now && (!latest || start > latest)) latest = start;
    }
  }
  return latest!;
}

export function hoursBetween(earlier: Date, later: Date): number {
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}
