import cronstrue from 'cronstrue';

// Hermes' schedule parser accepts five shapes — durations ("30m"), intervals
// ("every 2h"), 5/6-field cron expressions, ISO timestamps, and free-form
// English. Its `schedule_display` round-trips the canonical form, which is
// great for accuracy but useless to a non-engineer reading "0 12 * * *".
// This helper renders each shape into a sentence a person can read.
export function humanizeSchedule(display: string | null | undefined): string | null {
  if (!display) return null;
  const trimmed = display.trim();
  if (!trimmed) return null;

  // "every 30m", "every 1440m", "every 2h", "every 1d"
  const everyMatch = trimmed.match(/^every\s+(\d+)\s*([mhd])(?:in|inute|inutes|r|rs|our|ours|ay|ays)?$/i);
  if (everyMatch) {
    const value = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2].toLowerCase();
    if (unit === 'm') return everyMinutes(value);
    if (unit === 'h') return value === 1 ? 'Every hour' : `Every ${value} hours`;
    if (unit === 'd') return value === 1 ? 'Every day' : `Every ${value} days`;
  }

  // One-shot duration: "30m", "2h", "1d"
  const durationMatch = trimmed.match(/^(\d+)\s*([mhd])$/i);
  if (durationMatch) {
    const value = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();
    if (unit === 'm') return value === 1 ? 'Once, in 1 minute' : `Once, in ${value} minutes`;
    if (unit === 'h') return value === 1 ? 'Once, in 1 hour' : `Once, in ${value} hours`;
    if (unit === 'd') return value === 1 ? 'Once, tomorrow' : `Once, in ${value} days`;
  }

  // ISO timestamp: "2026-02-03T14:00:00"
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) {
      return `Once on ${date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })}`;
    }
  }

  // 5- or 6-field cron expression
  const fields = trimmed.split(/\s+/);
  if (fields.length === 5 || fields.length === 6) {
    try {
      return cronstrue.toString(trimmed, { use24HourTimeFormat: false, verbose: false });
    } catch {
      // Fall through to the raw string for unparseable expressions.
    }
  }

  return trimmed;
}

function everyMinutes(value: number): string {
  if (value % 1440 === 0) {
    const days = value / 1440;
    return days === 1 ? 'Every day' : `Every ${days} days`;
  }
  if (value % 60 === 0) {
    const hours = value / 60;
    return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
  }
  return value === 1 ? 'Every minute' : `Every ${value} minutes`;
}
