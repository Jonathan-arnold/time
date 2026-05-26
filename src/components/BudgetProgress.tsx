import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { addDays, addMonths, addWeeks, format } from 'date-fns'
import { db } from '../db'
import type { Block, Budget, Category } from '../db'
import {
  budgetPeriod,
  periodCoveredDays,
  periodScheduledDays,
} from '../lib/budget'
import { indentCategories } from '../lib/categories'
import { formatDuration, isoDate, parseIsoDate } from '../lib/time'

/** One categorized block of past time is 30 minutes. */
const BLOCK_MINUTES = 30

interface BudgetProgressProps {
  budget: Budget
  /** All budgets — needed to resolve which days this budget governs. */
  budgets: Budget[]
  categories: Category[]
  blocks: Block[]
}

/**
 * YNAB-style progress view for one budget: each category's allocated time
 * against the time actually categorized to it within the current period.
 * Categories with no allocation are hidden unless time was assigned to them.
 */
export default function BudgetProgress({
  budget,
  budgets,
  categories,
  blocks,
}: BudgetProgressProps) {
  // How many periods (or days, in day scale) to step away from the one
  // containing today. One-off budgets have a single fixed period, so
  // navigation is disabled for them.
  const [offset, setOffset] = useState(0)
  // Whether to view the whole period at once, or zoom in to a single day.
  // Persisted per-budget in localStorage so each budget remembers its last
  // scale across reloads. The default is 'period' for previously-unseen budgets.
  const scaleKey = `budgetProgress.scale.${budget.id}`
  const [scale, setScale] = useState<'period' | 'day'>(() => {
    if (typeof window === 'undefined') return 'period'
    const stored = window.localStorage.getItem(scaleKey)
    return stored === 'day' || stored === 'period' ? stored : 'period'
  })

  // Switching scale would otherwise leave the offset meaning a different
  // span of time — reset so the toggle always lands on "current".
  const setScaleReset = (s: 'period' | 'day') => {
    setScale(s)
    setOffset(0)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(scaleKey, s)
    }
  }

  const allocations = useLiveQuery(
    () => db.budgetAllocations.where('budgetId').equals(budget.id).toArray(),
    [budget.id],
  )

  // The reference day for the period being viewed: today, shifted by the
  // offset (a week or a month at a time, matching the budget's recurrence).
  const refIso = useMemo(() => {
    const today = parseIsoDate(isoDate(new Date()))
    if (scale === 'day') return isoDate(addDays(today, offset))
    if (budget.type === 'oneoff') return isoDate(today)
    const shifted =
      budget.recurrence === 'monthly'
        ? addMonths(today, offset)
        : addWeeks(today, offset)
    return isoDate(shifted)
  }, [budget.type, budget.recurrence, offset, scale])

  const { startIso, endIso } = useMemo(
    () => budgetPeriod(budget, refIso),
    [budget, refIso],
  )

  // The days within this period the budget actually governs — time on any
  // other day (a weekday budget's weekend, etc.) doesn't count against it.
  const coveredDays = useMemo(
    () => periodCoveredDays(budgets, budget, refIso),
    [budgets, budget, refIso],
  )

  // Days the schedule alone would cover, ignoring any overriding budgets.
  // Allocation is minutes-per-period, so per-day rate = a.minutes /
  // scheduledDays. When a one-off overrides some of those days, the
  // recurring budget's effective period total shrinks proportionally.
  const scheduledDays = useMemo(
    () => periodScheduledDays(budget, refIso),
    [budget, refIso],
  )

  // Whether the focused day in day-scale mode is actually one this budget
  // governs. Period scale always counts as "covered".
  const dayCovered = scale !== 'day' || coveredDays.has(refIso)

  // Minutes allocated directly to each category. The per-day allocation rate
  // is a.minutes / scheduledDays; day scale shows one day's share, while
  // period scale shows the sum across days the budget actually governs
  // (overridden days drop out, shrinking the effective period total).
  const allocDirect = useMemo(() => {
    const map = new Map<string, number>()
    const scheduled = scheduledDays.size
    const factor =
      scheduled === 0
        ? 0
        : scale === 'day'
          ? dayCovered ? 1 / scheduled : 0
          : coveredDays.size / scheduled
    for (const a of allocations ?? []) {
      map.set(a.categoryId, Math.round(a.minutes * factor))
    }
    return map
  }, [allocations, scale, coveredDays, scheduledDays, dayCovered])

  // Minutes categorized directly to each category within the viewed range —
  // counting only blocks on covered days (or the single day, in day scale)
  // and inside the coverage window.
  const assignedDirect = useMemo(() => {
    const map = new Map<string, number>()
    for (const b of blocks) {
      const d = new Date(b.start)
      const dayIso = isoDate(d)
      if (scale === 'day') {
        if (dayIso !== refIso) continue
        if (!dayCovered) continue
      } else if (!coveredDays.has(dayIso)) continue
      const minuteOfDay = d.getHours() * 60 + d.getMinutes()
      if (minuteOfDay < budget.coverStart || minuteOfDay >= budget.coverEnd)
        continue
      map.set(b.categoryId, (map.get(b.categoryId) ?? 0) + BLOCK_MINUTES)
    }
    return map
  }, [blocks, coveredDays, budget.coverStart, budget.coverEnd, scale, refIso, dayCovered])

  // Direct children of each category, keyed by parent id ('' = top level).
  const childIds = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const c of categories) {
      const arr = map.get(c.parentId ?? '') ?? []
      arr.push(c.id)
      map.set(c.parentId ?? '', arr)
    }
    return map
  }, [categories])

  // Roll a per-category map up so each category's total includes everything
  // allocated/assigned anywhere in its subtree (plus its own direct value).
  const rollUp = useMemo(() => {
    return (direct: Map<string, number>) => {
      const memo = new Map<string, number>()
      const compute = (id: string): number => {
        const cached = memo.get(id)
        if (cached !== undefined) return cached
        let total = direct.get(id) ?? 0
        for (const child of childIds.get(id) ?? []) total += compute(child)
        memo.set(id, total)
        return total
      }
      for (const c of categories) compute(c.id)
      return memo
    }
  }, [childIds, categories])

  // How far through the period we are: covered-day minutes that have already
  // elapsed, over the period's total coverage minutes. Past periods read 1,
  // future periods 0. A row is "ahead of pace" when its assigned/allocated
  // ratio outruns this.
  const elapsedFraction = useMemo(() => {
    const windowLen = budget.coverEnd - budget.coverStart
    if (windowLen === 0) return 1
    const now = new Date()
    const todayIso = isoDate(now)
    const nowMinute = now.getHours() * 60 + now.getMinutes()
    if (scale === 'day') {
      if (!dayCovered) return 0
      if (refIso < todayIso) return 1
      if (refIso > todayIso) return 0
      return Math.min(
        1,
        Math.max(0, nowMinute - budget.coverStart) / windowLen,
      )
    }
    const total = coveredDays.size * windowLen
    if (total === 0) return 1
    let elapsed = 0
    for (const dayIso of coveredDays) {
      if (dayIso < todayIso) elapsed += windowLen
      else if (dayIso === todayIso)
        elapsed += Math.min(windowLen, Math.max(0, nowMinute - budget.coverStart))
    }
    return Math.min(1, elapsed / total)
  }, [coveredDays, budget.coverStart, budget.coverEnd, scale, refIso, dayCovered])

  const allocTotal = useMemo(() => rollUp(allocDirect), [rollUp, allocDirect])
  const assignedTotal = useMemo(
    () => rollUp(assignedDirect),
    [rollUp, assignedDirect],
  )

  // Color lookup so timeline slots can paint by category.
  const catColor = useMemo(() => {
    const map = new Map<string, { color: string; name: string }>()
    for (const c of categories) map.set(c.id, { color: c.color, name: c.name })
    return map
  }, [categories])

  // One 30-min entry per slot in the covered window, in chronological order.
  // Period mode concatenates each covered day's window; day mode shows one
  // day. Slots with no categorized block render as empty/gray.
  const timeline = useMemo(() => {
    const days =
      scale === 'day'
        ? dayCovered
          ? [refIso]
          : []
        : [...coveredDays].sort()
    if (days.length === 0) return { slots: [], dayLengths: [] as number[] }
    const byKey = new Map<string, string>()
    for (const b of blocks) {
      const d = new Date(b.start)
      const minute = d.getHours() * 60 + d.getMinutes()
      byKey.set(`${isoDate(d)}|${minute}`, b.categoryId)
    }
    const slots: {
      day: string
      minute: number
      categoryId: string | null
    }[] = []
    const perDay = (budget.coverEnd - budget.coverStart) / BLOCK_MINUTES
    for (const day of days) {
      for (let m = budget.coverStart; m < budget.coverEnd; m += BLOCK_MINUTES) {
        slots.push({ day, minute: m, categoryId: byKey.get(`${day}|${m}`) ?? null })
      }
    }
    return { slots, dayLengths: days.map(() => perDay) }
  }, [blocks, scale, refIso, dayCovered, coveredDays, budget.coverStart, budget.coverEnd])

  const tree = useMemo(() => indentCategories(categories), [categories])

  // Show a category only if it has an allocation or has time assigned —
  // either directly or somewhere in its subtree.
  const rows = tree.filter(
    ({ category }) =>
      (allocTotal.get(category.id) ?? 0) > 0 ||
      (assignedTotal.get(category.id) ?? 0) > 0,
  )

  // Group the visible rows into sections, one per top-level category. Since
  // any category with subtree activity is shown along with its ancestors, the
  // row list is contiguous and always opens a section with a depth-0 row.
  const sections = useMemo(() => {
    const out: { head: (typeof rows)[number]; children: typeof rows }[] = []
    for (const row of rows) {
      if (row.depth === 0) out.push({ head: row, children: [] })
      else out[out.length - 1]?.children.push(row)
    }
    return out
  }, [rows])

  // Period-wide totals across every top-level category.
  const summary = tree
    .filter(({ depth }) => depth === 0)
    .reduce(
      (acc, { category }) => ({
        allocated: acc.allocated + (allocTotal.get(category.id) ?? 0),
        assigned: acc.assigned + (assignedTotal.get(category.id) ?? 0),
      }),
      { allocated: 0, assigned: 0 },
    )

  if (!allocations) return <div className="text-slate-400">Loading…</div>

  const periodLabel =
    scale === 'day'
      ? format(parseIsoDate(refIso), 'EEE, MMM d')
      : `${format(parseIsoDate(startIso), 'MMM d')} – ${format(
          parseIsoDate(endIso),
          'MMM d',
        )}`
  const canNavigate = budget.type !== 'oneoff' || scale === 'day'
  const isCurrent = offset === 0
  const currentLabel = scale === 'day' ? 'today' : 'current'

  return (
    <div>
      {/* Period header with prev/next navigation */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            {budget.name}
          </h2>
          <p className="text-sm text-slate-500">
            {periodLabel}
            {isCurrent && canNavigate && ` · ${currentLabel}`}
            {' · '}
            {formatDuration(summary.assigned)} of{' '}
            {formatDuration(summary.allocated)} assigned
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Scale toggle: whole-period totals vs. just the focused day. */}
          <div className="flex shrink-0 gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            {(['day', 'period'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScaleReset(s)}
                className={
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors ' +
                  (scale === s
                    ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                    : 'text-slate-500 hover:text-slate-900')
                }
              >
                {s === 'day' ? 'Day' : 'Period'}
              </button>
            ))}
          </div>
          {canNavigate && (
            <div className="flex items-center gap-1">
              <NavButton label="◀" onClick={() => setOffset((o) => o - 1)} />
              <button
                type="button"
                onClick={() => setOffset(0)}
                disabled={isCurrent}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 disabled:text-slate-300"
              >
                Today
              </button>
              <NavButton label="▶" onClick={() => setOffset((o) => o + 1)} />
            </div>
          )}
        </div>
      </div>

      {timeline.slots.length > 0 && (
        <TimelineBar
          slots={timeline.slots}
          dayLengths={timeline.dayLengths}
          catColor={catColor}
          coverStart={budget.coverStart}
        />
      )}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 px-6 py-16 text-center text-sm text-slate-400">
          Nothing allocated or assigned for this period yet.
        </div>
      ) : (
        <div>
          <div className="sticky top-0 z-10 flex items-center gap-2.5 border-y border-slate-200 bg-white px-3 py-2 text-[15px] font-medium uppercase tracking-wide text-slate-400">
            <span className="flex-1">Category</span>
            <span className="w-20 text-right">Assigned</span>
            <span className="w-20 text-right">Available</span>
          </div>
          <div className="mt-3 space-y-3">
            {sections.map((section) => (
              <ul
                key={section.head.category.id}
                className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm"
              >
                {[section.head, ...section.children].map(
                  ({ category, depth }) => (
                    <ProgressRow
                      key={category.id}
                      category={category}
                      depth={depth}
                      topLevel={depth === 0}
                      allocated={allocTotal.get(category.id) ?? 0}
                      assigned={assignedTotal.get(category.id) ?? 0}
                      elapsedFraction={elapsedFraction}
                    />
                  ),
                )}
              </ul>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface TimelineBarProps {
  slots: { day: string; minute: number; categoryId: string | null }[]
  /** Number of slots per day, in render order — for vertical day dividers. */
  dayLengths: number[]
  catColor: Map<string, { color: string; name: string }>
  coverStart: number
}

/**
 * Horizontal bar showing every 30-min slot in the period in chronological
 * order. Categorized slots paint with their category color; uncategorized
 * slots stay neutral. Days are separated by thin dividers.
 */
function TimelineBar({ slots, dayLengths, catColor, coverStart }: TimelineBarProps) {
  const dayStartIndices = useMemo(() => {
    const out: number[] = []
    let acc = 0
    for (const len of dayLengths) {
      out.push(acc)
      acc += len
    }
    return out
  }, [dayLengths])

  const [hover, setHover] = useState<{
    index: number
    x: number
    y: number
  } | null>(null)

  const hovered = hover ? slots[hover.index] : null
  const hoveredMeta = hovered?.categoryId ? catColor.get(hovered.categoryId) : null

  // Expand the hovered slot outward while the neighbors share its categoryId,
  // so the tooltip describes the whole contiguous run rather than a single
  // 30-min cell. Day boundaries do not split a run; we treat the timeline as
  // a flat sequence of slots.
  const run = useMemo(() => {
    if (!hover) return null
    const target = slots[hover.index].categoryId
    let lo = hover.index
    let hi = hover.index
    while (lo > 0 && slots[lo - 1].categoryId === target) lo--
    while (hi < slots.length - 1 && slots[hi + 1].categoryId === target) hi++
    return { lo, hi, length: hi - lo + 1 }
  }, [hover, slots])

  return (
    <div className="relative mb-5">
      <div
        className="flex h-7 w-full overflow-hidden rounded-md border border-slate-200 bg-slate-50"
        onMouseLeave={() => setHover(null)}
      >
        {slots.map((s, i) => {
          const meta = s.categoryId ? catColor.get(s.categoryId) : null
          const isDayStart = dayStartIndices.includes(i) && i !== 0
          return (
            <div
              key={i}
              className="h-full flex-1"
              style={{
                backgroundColor: meta?.color ?? 'transparent',
                borderLeft: isDayStart ? '1px solid white' : undefined,
              }}
              onMouseMove={(ev) => {
                const box = ev.currentTarget.parentElement?.getBoundingClientRect()
                setHover({
                  index: i,
                  x: ev.clientX - (box?.left ?? 0),
                  y: ev.clientY - (box?.top ?? 0),
                })
              }}
            />
          )
        })}
      </div>
      {hovered && run && (() => {
        const first = slots[run.lo]
        const last = slots[run.hi]
        const minutes = run.length * BLOCK_MINUTES
        const sameDay = first.day === last.day
        const rangeLabel = sameDay
          ? `${format(parseIsoDate(first.day), 'EEE MMM d')} · ${formatHour(first.minute)}–${formatHour(last.minute + BLOCK_MINUTES)}`
          : `${format(parseIsoDate(first.day), 'EEE')} ${formatHour(first.minute)} – ${format(parseIsoDate(last.day), 'EEE')} ${formatHour(last.minute + BLOCK_MINUTES)}`
        return (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow-lg"
            style={{ left: hover!.x, top: hover!.y - 8 }}
          >
            <span className="font-medium">
              {hoveredMeta?.name ?? 'Uncategorized'}
            </span>{' '}
            <span className="text-slate-300">
              {formatDuration(minutes)} · {rangeLabel}
            </span>
          </div>
        )
      })()}
      {dayLengths.length > 1 && (
        <div className="mt-1 flex text-[10px] text-slate-400">
          {dayLengths.map((len, i) => (
            <span
              key={i}
              className="text-center"
              style={{ flex: len }}
            >
              {format(parseIsoDate(slots[dayStartIndices[i]].day), 'EEE')}
            </span>
          ))}
        </div>
      )}
      {dayLengths.length === 1 && (
        <div className="mt-1 flex text-[10px] text-slate-400">
          <span className="flex-1 text-left">
            {formatHour(coverStart)}
          </span>
          <span className="flex-1 text-right">
            {formatHour(coverStart + dayLengths[0] * BLOCK_MINUTES)}
          </span>
        </div>
      )}
    </div>
  )
}

function formatHour(minute: number): string {
  const h = Math.floor(minute / 60) % 24
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** A small circular step button for period navigation. */
function NavButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-xs text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-900"
    >
      {label}
    </button>
  )
}

interface ProgressRowProps {
  category: Category
  depth: number
  /** Minutes allocated to this category's subtree for the period. */
  allocated: number
  /** Minutes actually categorized to this category's subtree this period. */
  assigned: number
  /** Fraction of the period's covered time that has already elapsed (0–1). */
  elapsedFraction: number
  /** Whether this is a top-level category — styled as a section heading. */
  topLevel: boolean
}

/** One category's allocated-vs-assigned progress bar. */
function ProgressRow({
  category,
  depth,
  allocated,
  assigned,
  elapsedFraction,
  topLevel,
}: ProgressRowProps) {
  const unbudgeted = allocated === 0
  // Over budget: assigned time past the allocation, or any time against a
  // zero allocation.
  const over = unbudgeted ? assigned > 0 : assigned > allocated
  const ratio = unbudgeted ? 1 : Math.min(1, assigned / allocated)

  // Time still available to spend before hitting the allocation — negative
  // once over budget.
  const available = allocated - assigned

  // Where the fill would reach if spending exactly tracked the period's
  // elapsed time — the "on pace" point. Only meaningful for budgeted rows
  // partway through a live period.
  const showPaceMarker =
    !unbudgeted && elapsedFraction > 0 && elapsedFraction < 1

  // The Available figure reads yellow when overspent, neutral otherwise.
  const bubble = over
    ? 'bg-amber-100 text-amber-700'
    : 'bg-slate-100 text-slate-700'

  return (
    <li
      className={`flex items-center gap-2.5 px-3 ${
        topLevel
          ? 'border-b border-slate-300 bg-white py-3'
          : 'py-2.5'
      }`}
      style={{ paddingLeft: 12 + depth * 20 }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <span
            className={
              topLevel
                ? 'text-[15px] font-semibold text-slate-900'
                : 'text-sm font-medium text-slate-700'
            }
          >
            {category.name}
          </span>
        </div>
        <div className="relative mt-1.5 h-1.5 rounded-full bg-slate-100">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${ratio * 100}%`, backgroundColor: category.color }}
          />
          {showPaceMarker && (
            /* Midnight-colored dot at the pace marker. */
            <span
              className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-900 ring-1 ring-white"
              style={{ left: `${elapsedFraction * 100}%` }}
              title={`On pace: ${formatDuration(
                Math.round(allocated * elapsedFraction),
              )} of ${formatDuration(allocated)}`}
            />
          )}
        </div>
      </div>
      <span
        className={`w-20 shrink-0 text-right tabular-nums text-slate-800 ${
          topLevel ? 'text-base font-semibold' : 'text-sm font-medium'
        }`}
      >
        {formatDuration(assigned)}
      </span>
      <span className="w-20 shrink-0 text-right">
        <span
          className={`inline-block rounded-full px-2 py-0.5 tabular-nums ${
            topLevel ? 'text-sm font-semibold' : 'text-xs font-medium'
          } ${bubble}`}
        >
          {formatDuration(available)}
        </span>
      </span>
    </li>
  )
}
