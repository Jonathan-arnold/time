import { format, parse, startOfDay } from 'date-fns'

/** Length of one block in milliseconds (30 minutes). */
export const BLOCK_MS = 30 * 60 * 1000

/** Number of 30-minute blocks in a day. */
export const BLOCKS_PER_DAY = 48

/** Floor an epoch-ms timestamp down to its 30-minute block boundary. */
export function alignToBlock(ts: number): number {
  return Math.floor(ts / BLOCK_MS) * BLOCK_MS
}

/** Format a Date as a `yyyy-MM-dd` ISO date string in local time. */
export function isoDate(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

/** Parse a `yyyy-MM-dd` string into a local Date at midnight. */
export function parseIsoDate(iso: string): Date {
  return startOfDay(parse(iso, 'yyyy-MM-dd', new Date()))
}

/**
 * The 48 block-start timestamps for the given local day, earliest first.
 */
export function dayBlockStarts(iso: string): number[] {
  const base = parseIsoDate(iso).getTime()
  return Array.from({ length: BLOCKS_PER_DAY }, (_, i) => base + i * BLOCK_MS)
}

/** A block is "past" once its start time has elapsed. */
export function isBlockPast(start: number, now: number = Date.now()): boolean {
  return start < alignToBlock(now)
}

/** Label for a block, e.g. `6:00 AM`. */
export function formatBlockTime(start: number): string {
  return format(start, 'h:mm a')
}

/**
 * Format a minutes-from-midnight value as a clock time, e.g. `9:30 AM`.
 * `1440` (end of day) renders as `Midnight`.
 */
export function formatTimeOfDay(minutes: number): string {
  if (minutes >= 24 * 60) return 'Midnight'
  const h24 = Math.floor(minutes / 60)
  const m = minutes % 60
  const ampm = h24 < 12 ? 'AM' : 'PM'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

/** Human-readable duration from a minute count, e.g. `1h 30m`. */
export function formatDuration(minutes: number): string {
  const sign = minutes < 0 ? '-' : ''
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return sign + ([h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m')
}

/** Friendly label for a day, e.g. `Wed, May 20`. */
export function formatDayLabel(iso: string): string {
  return format(parseIsoDate(iso), 'EEE, MMM d')
}
