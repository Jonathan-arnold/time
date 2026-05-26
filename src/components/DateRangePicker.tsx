import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns'
import { isoDate, parseIsoDate } from '../lib/time'

interface DateRangePickerProps {
  start: string
  end: string
  onChange: (start: string, end: string) => void
}

/** Flight-search-style range picker: two-month calendar with highlighted range. */
export default function DateRangePicker({ start, end, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState<Date | null>(null)
  const [pendingStart, setPendingStart] = useState<Date | null>(null)
  const [pendingEnd, setPendingEnd] = useState<Date | null>(null)
  const [viewMonth, setViewMonth] = useState<Date>(() =>
    startOfMonth(start ? parseIsoDate(start) : new Date()),
  )
  const rootRef = useRef<HTMLDivElement | null>(null)

  const startDate = start ? parseIsoDate(start) : null
  const endDate = end ? parseIsoDate(end) : null

  const canAccept = !!(pendingStart && pendingEnd)

  function commit() {
    if (!pendingStart || !pendingEnd) return
    const [lo, hi] =
      pendingStart <= pendingEnd ? [pendingStart, pendingEnd] : [pendingEnd, pendingStart]
    onChange(isoDate(lo), isoDate(hi))
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
      else if (e.key === 'Enter' && canAccept) {
        e.preventDefault()
        commit()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, canAccept, pendingStart, pendingEnd])

  function openPicker() {
    setPendingStart(startDate)
    setPendingEnd(endDate)
    setHover(null)
    setViewMonth(startOfMonth(startDate ?? new Date()))
    setOpen(true)
  }

  function selectDay(day: Date) {
    // No selection yet, or both endpoints already chosen — start fresh.
    if (!pendingStart || (pendingStart && pendingEnd)) {
      setPendingStart(day)
      setPendingEnd(null)
      setHover(day)
      return
    }
    // One endpoint picked — completing the range.
    setPendingEnd(day)
    setHover(null)
  }

  const label = useMemo(() => {
    if (startDate && endDate) {
      const sameYear = startDate.getFullYear() === endDate.getFullYear()
      const sameMonthYear = sameYear && startDate.getMonth() === endDate.getMonth()
      if (isSameDay(startDate, endDate)) return format(startDate, 'MMM d, yyyy')
      if (sameMonthYear) {
        return `${format(startDate, 'MMM d')} – ${format(endDate, 'd, yyyy')}`
      }
      if (sameYear) {
        return `${format(startDate, 'MMM d')} – ${format(endDate, 'MMM d, yyyy')}`
      }
      return `${format(startDate, 'MMM d, yyyy')} – ${format(endDate, 'MMM d, yyyy')}`
    }
    if (startDate) return `${format(startDate, 'MMM d, yyyy')} – End date`
    return 'Pick dates'
  }, [startDate, endDate])

  const hint = pendingStart && !pendingEnd
    ? 'Now pick the end date'
    : pendingStart && pendingEnd
      ? 'Press Enter or Accept to confirm'
      : 'Pick a start date'

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPicker())}
        className={
          'flex items-center gap-2 rounded-lg border bg-white px-3 py-1.5 text-sm font-medium outline-none transition-colors ' +
          (open
            ? 'border-slate-400 text-slate-900'
            : 'border-slate-200 text-slate-900 hover:border-slate-300')
        }
      >
        <CalendarIcon />
        <span>{label}</span>
      </button>

      {open && (
        <div className="absolute left-0 z-20 mt-2 rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
          <div className="mb-3 flex items-center justify-between">
            <NavButton onClick={() => setViewMonth((m) => subMonths(m, 1))} aria-label="Previous month">
              <ChevronLeft />
            </NavButton>
            <div className="flex flex-1 justify-around px-2">
              <MonthTitle date={viewMonth} />
              <MonthTitle date={addMonths(viewMonth, 1)} />
            </div>
            <NavButton onClick={() => setViewMonth((m) => addMonths(m, 1))} aria-label="Next month">
              <ChevronRight />
            </NavButton>
          </div>

          <div className="flex gap-6">
            <MonthGrid
              month={viewMonth}
              pendingStart={pendingStart}
              pendingEnd={pendingEnd}
              hover={hover}
              onPick={selectDay}
              onHover={setHover}
            />
            <MonthGrid
              month={addMonths(viewMonth, 1)}
              pendingStart={pendingStart}
              pendingEnd={pendingEnd}
              hover={hover}
              onPick={selectDay}
              onHover={setHover}
            />
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-400">{hint}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setPendingStart(null)
                  setPendingEnd(null)
                  setHover(null)
                }}
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={commit}
                disabled={!canAccept}
                className={
                  'rounded-md px-3 py-1 text-xs font-semibold transition-colors ' +
                  (canAccept
                    ? 'bg-slate-900 text-white hover:bg-slate-800'
                    : 'cursor-not-allowed bg-slate-100 text-slate-400')
                }
              >
                Accept
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MonthTitle({ date }: { date: Date }) {
  return (
    <div className="text-sm font-semibold text-slate-900">{format(date, 'MMMM yyyy')}</div>
  )
}

function NavButton({
  children,
  onClick,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
      {...rest}
    >
      {children}
    </button>
  )
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

function MonthGrid({
  month,
  pendingStart,
  pendingEnd,
  hover,
  onPick,
  onHover,
}: {
  month: Date
  pendingStart: Date | null
  pendingEnd: Date | null
  hover: Date | null
  onPick: (d: Date) => void
  onHover: (d: Date | null) => void
}) {
  const gridStart = startOfWeek(startOfMonth(month), { weekStartsOn: 0 })
  const gridEnd = endOfWeek(endOfMonth(month), { weekStartsOn: 0 })
  const days: Date[] = []
  for (let d = gridStart; d <= gridEnd; d = new Date(d.getTime() + 86400000)) {
    days.push(d)
  }

  // Resolve the range to highlight. While mid-selection (no pendingEnd yet),
  // follow the hovered day so the user sees a live preview.
  let rangeLo: Date | null = null
  let rangeHi: Date | null = null
  if (pendingStart && pendingEnd) {
    ;[rangeLo, rangeHi] =
      pendingStart <= pendingEnd ? [pendingStart, pendingEnd] : [pendingEnd, pendingStart]
  } else if (pendingStart) {
    const other = hover ?? pendingStart
    ;[rangeLo, rangeHi] = pendingStart <= other ? [pendingStart, other] : [other, pendingStart]
  }

  const today = new Date()

  return (
    <div className="w-56">
      <div className="mb-1 grid grid-cols-7 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {WEEKDAY_LABELS.map((d, i) => (
          <div key={i}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-1">
        {days.map((day) => {
          const inMonth = isSameMonth(day, month)
          const inRange =
            rangeLo && rangeHi && day >= stripTime(rangeLo) && day <= stripTime(rangeHi)
          const isLo = rangeLo && isSameDay(day, rangeLo)
          const isHi = rangeHi && isSameDay(day, rangeHi)
          const isEndpoint = isLo || isHi
          const isToday = isSameDay(day, today)

          return (
            <div
              key={day.toISOString()}
              className={
                'relative h-8 ' +
                (inRange && !isEndpoint ? 'bg-slate-100 ' : '') +
                (inRange && isLo && !isHi ? 'bg-gradient-to-r from-transparent to-slate-100 ' : '') +
                (inRange && isHi && !isLo ? 'bg-gradient-to-l from-transparent to-slate-100 ' : '')
              }
            >
              <button
                type="button"
                disabled={!inMonth}
                onClick={() => inMonth && onPick(day)}
                onMouseEnter={() => inMonth && onHover(day)}
                onMouseLeave={() => onHover(null)}
                className={
                  'relative z-10 mx-auto flex h-8 w-8 items-center justify-center rounded-full text-sm tabular-nums transition-colors ' +
                  (!inMonth
                    ? 'cursor-default text-transparent'
                    : isEndpoint
                      ? 'bg-slate-900 font-semibold text-white'
                      : inRange
                        ? 'font-medium text-slate-900 hover:bg-slate-200'
                        : isToday
                          ? 'font-semibold text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-100'
                          : 'text-slate-700 hover:bg-slate-100')
                }
              >
                {day.getDate()}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function CalendarIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-slate-400"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  )
}

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

function ChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}
