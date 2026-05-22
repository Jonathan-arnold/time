import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { addMonths, addWeeks, format } from 'date-fns'
import { db } from '../db'
import type { Block, Budget, Category } from '../db'
import { budgetPeriod, periodCoveredDays } from '../lib/budget'
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
  // How many periods to step away from the one containing today. One-off
  // budgets have a single fixed period, so navigation is disabled for them.
  const [offset, setOffset] = useState(0)

  const allocations = useLiveQuery(
    () => db.budgetAllocations.where('budgetId').equals(budget.id).toArray(),
    [budget.id],
  )

  // The reference day for the period being viewed: today, shifted by the
  // offset (a week or a month at a time, matching the budget's recurrence).
  const refIso = useMemo(() => {
    const today = parseIsoDate(isoDate(new Date()))
    if (budget.type === 'oneoff') return isoDate(today)
    const shifted =
      budget.recurrence === 'monthly'
        ? addMonths(today, offset)
        : addWeeks(today, offset)
    return isoDate(shifted)
  }, [budget.type, budget.recurrence, offset])

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

  // Minutes allocated directly to each category.
  const allocDirect = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of allocations ?? []) map.set(a.categoryId, a.minutes)
    return map
  }, [allocations])

  // Minutes categorized directly to each category within this period —
  // counting only blocks on covered days and inside the coverage window.
  const assignedDirect = useMemo(() => {
    const map = new Map<string, number>()
    for (const b of blocks) {
      const d = new Date(b.start)
      if (!coveredDays.has(isoDate(d))) continue
      const minuteOfDay = d.getHours() * 60 + d.getMinutes()
      if (minuteOfDay < budget.coverStart || minuteOfDay >= budget.coverEnd)
        continue
      map.set(b.categoryId, (map.get(b.categoryId) ?? 0) + BLOCK_MINUTES)
    }
    return map
  }, [blocks, coveredDays, budget.coverStart, budget.coverEnd])

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
    const total = coveredDays.size * windowLen
    if (total === 0) return 1
    const now = new Date()
    const todayIso = isoDate(now)
    const nowMinute = now.getHours() * 60 + now.getMinutes()
    let elapsed = 0
    for (const dayIso of coveredDays) {
      if (dayIso < todayIso) elapsed += windowLen
      else if (dayIso === todayIso)
        elapsed += Math.min(windowLen, Math.max(0, nowMinute - budget.coverStart))
    }
    return Math.min(1, elapsed / total)
  }, [coveredDays, budget.coverStart, budget.coverEnd])

  const allocTotal = useMemo(() => rollUp(allocDirect), [rollUp, allocDirect])
  const assignedTotal = useMemo(
    () => rollUp(assignedDirect),
    [rollUp, assignedDirect],
  )

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

  const periodLabel = `${format(parseIsoDate(startIso), 'MMM d')} – ${format(
    parseIsoDate(endIso),
    'MMM d',
  )}`
  const canNavigate = budget.type !== 'oneoff'
  const isCurrent = offset === 0

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
            {isCurrent && canNavigate && ' · current'}
            {' · '}
            {formatDuration(summary.assigned)} of{' '}
            {formatDuration(summary.allocated)} assigned
          </p>
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

  // How far spending has strayed from the pace marker, as a share of the
  // allocation. When there's no live pace to compare against, fall back to a
  // simple over/under check (full drift if over budget, none otherwise).
  const drift = showPaceMarker
    ? Math.abs(assigned / allocated - elapsedFraction)
    : over
      ? 1
      : 0

  // Color tier by distance from pace: green within 15 points either side,
  // amber within 25, red beyond. Unbudgeted time always reads red.
  const tier =
    unbudgeted || drift > 0.25 ? 'red' : drift > 0.15 ? 'amber' : 'green'

  // Bar fill color for the tier.
  const fill = {
    red: 'bg-red-500',
    amber: 'bg-amber-400',
    green: 'bg-emerald-500',
  }[tier]

  // Matching pill colors for the Available figure.
  const bubble = {
    red: 'bg-red-100 text-red-700',
    amber: 'bg-amber-100 text-amber-700',
    green: 'bg-emerald-100 text-emerald-700',
  }[tier]

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
            className={`shrink-0 rounded-full ${
              topLevel ? 'h-3 w-3' : 'h-2.5 w-2.5'
            }`}
            style={{ backgroundColor: category.color }}
          />
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
            className={`h-full rounded-full ${fill} transition-all`}
            style={{ width: `${ratio * 100}%` }}
          />
          {showPaceMarker && (
            <>
              {/* Yellow dots bounding the green "on pace" zone (±15%). */}
              <span
                className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400 ring-1 ring-white"
                style={{
                  left: `${Math.max(0, elapsedFraction - 0.15) * 100}%`,
                }}
              />
              <span
                className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400 ring-1 ring-white"
                style={{
                  left: `${Math.min(1, elapsedFraction + 0.15) * 100}%`,
                }}
              />
              {/* Green dot at the pace marker itself. */}
              <span
                className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-500 ring-1 ring-white"
                style={{ left: `${elapsedFraction * 100}%` }}
                title={`On pace: ${formatDuration(
                  Math.round(allocated * elapsedFraction),
                )} of ${formatDuration(allocated)}`}
              />
            </>
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
