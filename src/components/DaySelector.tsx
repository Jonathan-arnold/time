import { useEffect, useRef, useState } from 'react'
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
import { formatDayLabel, isoDate, parseIsoDate } from '../lib/time'

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
        className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-100"
      >
        ‹
      </button>

      <CalendarPopover value={value} onChange={onChange} />

      <button
        onClick={() => shift(1)}
        aria-label="Next day"
        disabled={value >= today}
        className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        ›
      </button>

      {value !== today && (
        <button
          onClick={() => onChange(today)}
          className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
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
        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 transition-colors hover:bg-slate-100"
      >
        <span className="text-sm font-semibold tabular-nums text-slate-900">
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

  return (
    <div
      role="dialog"
      aria-label="Choose a date"
      className="absolute left-1/2 top-full z-20 mt-2 w-72 -translate-x-1/2 rounded-xl border border-slate-200 bg-white p-3 shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between">
        <button
          onClick={() => setViewMonth((m) => addMonths(m, -1))}
          aria-label="Previous month"
          className="grid h-7 w-7 place-items-center rounded-md text-slate-600 transition-colors hover:bg-slate-100"
        >
          ‹
        </button>
        <span className="text-sm font-semibold text-slate-900">
          {format(viewMonth, 'MMMM yyyy')}
        </span>
        <button
          onClick={() => setViewMonth((m) => addMonths(m, 1))}
          aria-label="Next month"
          className="grid h-7 w-7 place-items-center rounded-md text-slate-600 transition-colors hover:bg-slate-100"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAYS.map((d, i) => (
          <div
            key={i}
            className="grid h-8 place-items-center text-xs font-medium text-slate-400"
          >
            {d}
          </div>
        ))}
        {days.map((day) => {
          const future = isAfter(day, today) && !isSameDay(day, today)
          const isSelected = isSameDay(day, selected)
          const isToday = isSameDay(day, today)
          const muted = !isSameMonth(day, viewMonth)
          return (
            <button
              key={day.getTime()}
              disabled={future}
              onClick={() => onChange(isoDate(day))}
              className={[
                'grid h-8 place-items-center rounded-md text-sm tabular-nums transition-colors',
                isSelected
                  ? 'bg-slate-900 font-semibold text-white'
                  : future
                    ? 'cursor-not-allowed text-slate-300'
                    : 'hover:bg-slate-100',
                !isSelected && isToday && 'font-semibold text-slate-900',
                !isSelected && !isToday && !future && muted
                  ? 'text-slate-400'
                  : '',
                !isSelected && !isToday && !future && !muted
                  ? 'text-slate-700'
                  : '',
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
