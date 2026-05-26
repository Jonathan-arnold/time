import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addDays,
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isAfter,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import {
  BLOCK_MS,
  BLOCKS_PER_DAY,
  formatDayLabel,
  isoDate,
  parseIsoDate,
} from '../lib/time'

interface DaySelectorProps {
  /** Selected day as a `yyyy-MM-dd` string. */
  value: string
  onChange: (iso: string) => void
}

/** Day picker: prev/next steppers, a calendar popover, and a Today shortcut. */
export default function DaySelector({ value, onChange }: DaySelectorProps) {
  const today = isoDate(new Date())
  const shift = (days: number) =>
    onChange(isoDate(addDays(parseIsoDate(value), days)))

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => shift(-1)}
        aria-label="Previous day"
        className="grid h-12 w-12 place-items-center rounded-lg border border-slate-200 bg-white text-lg text-slate-600 transition-colors hover:bg-slate-100 sm:h-9 sm:w-9 sm:text-base"
      >
        ‹
      </button>

      <CalendarPopover value={value} onChange={onChange} />

      <button
        onClick={() => shift(1)}
        aria-label="Next day"
        disabled={value >= today}
        className="grid h-12 w-12 place-items-center rounded-lg border border-slate-200 bg-white text-lg text-slate-600 transition-colors hover:bg-slate-100 sm:h-9 sm:w-9 sm:text-base disabled:cursor-not-allowed disabled:opacity-40"
      >
        ›
      </button>

      {value !== today && (
        <button
          onClick={() => onChange(today)}
          className="rounded-lg px-3.5 py-3 text-base font-medium text-slate-500 transition-colors hover:text-slate-900 sm:px-2.5 sm:py-1.5 sm:text-sm"
        >
          Today
        </button>
      )}
    </div>
  )
}

/** A button showing the selected day that opens a scrollable month calendar. */
function CalendarPopover({ value, onChange }: DaySelectorProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 transition-colors hover:bg-slate-100 sm:px-3 sm:py-1.5"
      >
        <span className="text-base font-semibold tabular-nums text-slate-900 sm:text-sm">
          {formatDayLabel(value)}
        </span>
      </button>

      {open && (
        <CalendarPanel
          value={value}
          onChange={(iso) => {
            onChange(iso)
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** The month-grid panel: month steppers plus a clickable day grid. */
function CalendarPanel({ value, onChange }: DaySelectorProps) {
  const today = new Date()
  const selected = parseIsoDate(value)
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(selected))

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(viewMonth)),
    end: endOfWeek(endOfMonth(viewMonth)),
  })

  // Count categorized blocks per day in the visible grid, so days where every
  // past 30-min block has been assigned can show green and partial days yellow.
  const rangeStart = days[0].getTime()
  const rangeEnd = days[days.length - 1].getTime() + 24 * 60 * 60 * 1000
  const monthBlocks = useLiveQuery(
    () =>
      db.blocks
        .where('start')
        .between(rangeStart, rangeEnd, true, false)
        .toArray(),
    [rangeStart, rangeEnd],
  )
  const categorizedByDay = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of monthBlocks ?? []) {
      const k = isoDate(new Date(b.start))
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [monthBlocks])
  const nowMs = today.getTime()
  function pastBlockCount(day: Date) {
    const elapsed = Math.floor((nowMs - day.getTime()) / BLOCK_MS)
    return Math.max(0, Math.min(BLOCKS_PER_DAY, elapsed))
  }

  return (
    <div
      role="dialog"
      aria-label="Choose a date"
      // On mobile, pin to the viewport (fixed) with margin insets so the
      // popover always uses the full available width regardless of where the
      // trigger sits. Desktop keeps the centered-on-trigger absolute popover.
      className="fixed inset-x-3 top-20 z-20 rounded-xl border border-slate-200 bg-white p-3 shadow-lg sm:absolute sm:inset-x-auto sm:left-1/2 sm:top-full sm:mt-2 sm:w-72 sm:-translate-x-1/2"
    >
      <div className="mb-2 flex items-center justify-between">
        <button
          onClick={() => setViewMonth((m) => addMonths(m, -1))}
          aria-label="Previous month"
          className="grid h-10 w-10 place-items-center rounded-md text-lg text-slate-600 transition-colors hover:bg-slate-100 sm:h-7 sm:w-7 sm:text-base"
        >
          ‹
        </button>
        <span className="text-sm font-semibold text-slate-900">
          {format(viewMonth, 'MMMM yyyy')}
        </span>
        <button
          onClick={() => setViewMonth((m) => addMonths(m, 1))}
          aria-label="Next month"
          className="grid h-10 w-10 place-items-center rounded-md text-lg text-slate-600 transition-colors hover:bg-slate-100 sm:h-7 sm:w-7 sm:text-base"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAYS.map((d, i) => (
          <div
            key={i}
            className="grid h-10 place-items-center text-sm font-medium text-slate-400 sm:h-8 sm:text-xs"
          >
            {d}
          </div>
        ))}
        {days.map((day) => {
          const future = isAfter(day, today) && !isSameDay(day, today)
          const isSelected = isSameDay(day, selected)
          const isToday = isSameDay(day, today)
          const muted = !isSameMonth(day, viewMonth)
          const past = future ? 0 : pastBlockCount(day)
          const cat = categorizedByDay.get(isoDate(day)) ?? 0
          const status: 'complete' | 'partial' | null =
            past === 0 ? null : cat >= past ? 'complete' : 'partial'
          const statusClass =
            !isSelected && status === 'complete'
              ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
              : !isSelected && status === 'partial'
                ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                : ''
          return (
            <button
              key={day.getTime()}
              disabled={future}
              onClick={() => onChange(isoDate(day))}
              className={[
                'grid h-12 place-items-center rounded-md text-base tabular-nums transition-colors sm:h-8 sm:text-sm',
                isSelected
                  ? 'bg-slate-900 font-semibold text-white'
                  : future
                    ? 'cursor-not-allowed text-slate-300'
                    : statusClass || 'hover:bg-slate-100',
                !isSelected && isToday && 'font-semibold',
                !isSelected &&
                  !isToday &&
                  !future &&
                  !status &&
                  (muted ? 'text-slate-400' : 'text-slate-700'),
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {day.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}
