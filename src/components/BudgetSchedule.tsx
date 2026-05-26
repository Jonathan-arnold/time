import { db, mutate } from '../db'
import type { Budget, Recurrence, Weekday } from '../db'
import { formatTimeOfDay } from '../lib/time'
import DateRangePicker from './DateRangePicker'

const WEEKDAYS: { value: Weekday; label: string }[] = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
]

const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1)

/** Hourly marks used for the coverage-window time pickers. */
const START_MARKS = Array.from({ length: 24 }, (_, i) => i * 60) // 0 … 1380
const END_MARKS = Array.from({ length: 24 }, (_, i) => (i + 1) * 60) // 60 … 1440

interface BudgetScheduleProps {
  budget: Budget
}

/** Scheduling editor for a budget: dates/days and hours covered. */
export default function BudgetSchedule({ budget }: BudgetScheduleProps) {
  const update = (changes: Partial<Budget>) =>
    mutate(() => db.budgets.update(budget.id, changes))

  function setRecurrence(recurrence: Recurrence) {
    update({ recurrence })
  }

  function toggleWeekday(day: Weekday) {
    const next = new Set(budget.weekdays)
    next.has(day) ? next.delete(day) : next.add(day)
    update({ weekdays: [...next].sort((a, b) => a - b) })
  }

  function toggleMonthDay(day: number) {
    const next = new Set(budget.monthDays)
    next.has(day) ? next.delete(day) : next.add(day)
    update({ monthDays: [...next].sort((a, b) => a - b) })
  }

  if (budget.type === 'oneoff') {
    const start = budget.startDate ?? ''
    const end = budget.endDate ?? ''
    const rangeInvalid = start && end && end < start
    return (
      <div className="space-y-7">
        <Field label="Dates">
          <DateRangePicker
            start={start}
            end={end}
            onChange={(startDate, endDate) =>
              update({ startDate: startDate || null, endDate: endDate || null })
            }
          />
          {rangeInvalid && (
            <p className="mt-2 text-xs text-red-500">
              End date must be on or after start date.
            </p>
          )}
        </Field>

        <Field label="Hours covered">
          <div className="flex items-center gap-2">
            <TimeSelect
              value={budget.coverStart}
              marks={START_MARKS.filter((m) => m < budget.coverEnd)}
              onChange={(coverStart) => update({ coverStart })}
            />
            <span className="text-sm text-slate-400">to</span>
            <TimeSelect
              value={budget.coverEnd}
              marks={END_MARKS.filter((m) => m > budget.coverStart)}
              onChange={(coverEnd) => update({ coverEnd })}
            />
          </div>
        </Field>

        <p className="text-xs text-slate-400">
          One-off budgets override any recurring budgets that cover the same days.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-7">
      {/* Recurrence */}
      <Field label="Repeats">
        <div className="flex gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {(['weekly', 'monthly'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRecurrence(r)}
              className={
                'rounded-md px-4 py-1.5 text-sm font-medium capitalize transition-colors ' +
                (budget.recurrence === r
                  ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                  : 'text-slate-500 hover:text-slate-900')
              }
            >
              {r}
            </button>
          ))}
        </div>
      </Field>

      {/* Days */}
      {budget.recurrence === 'monthly' ? (
        <Field label="Days of month">
          <div className="grid w-fit grid-cols-7 gap-1">
            {MONTH_DAYS.map((day) => {
              const on = budget.monthDays.includes(day)
              return (
                <button
                  key={day}
                  onClick={() => toggleMonthDay(day)}
                  className={
                    'h-8 w-8 rounded-md text-sm font-medium tabular-nums transition-colors ' +
                    (on
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200')
                  }
                >
                  {day}
                </button>
              )
            })}
          </div>
        </Field>
      ) : (
        <Field label="Days of week">
          <div className="flex gap-1">
            {WEEKDAYS.map(({ value, label }) => {
              const on = budget.weekdays.includes(value)
              return (
                <button
                  key={value}
                  onClick={() => toggleWeekday(value)}
                  className={
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors ' +
                    (on
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200')
                  }
                >
                  {label}
                </button>
              )
            })}
          </div>
        </Field>
      )}

      {/* Hours covered */}
      <Field label="Hours covered">
        <div className="flex items-center gap-2">
          <TimeSelect
            value={budget.coverStart}
            marks={START_MARKS.filter((m) => m < budget.coverEnd)}
            onChange={(coverStart) => update({ coverStart })}
          />
          <span className="text-sm text-slate-400">to</span>
          <TimeSelect
            value={budget.coverEnd}
            marks={END_MARKS.filter((m) => m > budget.coverStart)}
            onChange={(coverEnd) => update({ coverEnd })}
          />
        </div>
      </Field>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </h3>
      {children}
    </div>
  )
}

function TimeSelect({
  value,
  marks,
  onChange,
}: {
  value: number
  marks: number[]
  onChange: (minutes: number) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 outline-none focus:border-slate-400"
    >
      {marks.map((m) => (
        <option key={m} value={m}>
          {formatTimeOfDay(m)}
        </option>
      ))}
    </select>
  )
}
