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
        <ul className="divide-y divide-slate-100 border-y border-slate-100">
          {rows.map(({ category, depth }) => (
            <ProgressRow
              key={category.id}
              category={category}
              depth={depth}
              allocated={allocTotal.get(category.id) ?? 0}
              assigned={assignedTotal.get(category.id) ?? 0}
            />
          ))}
        </ul>
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
}

/** One category's allocated-vs-assigned progress bar. */
function ProgressRow({ category, depth, allocated, assigned }: ProgressRowProps) {
  const unbudgeted = allocated === 0
  const over = !unbudgeted && assigned > allocated
  const ratio = unbudgeted ? 1 : Math.min(1, assigned / allocated)
  const pct = unbudgeted
    ? null
    : Math.round((assigned / allocated) * 100)

  // Bar fill: amber when there's no allocation to measure against, red when
  // assigned time has run past the allocation, slate while on track.
  const fill = unbudgeted
    ? 'bg-amber-400'
    : over
      ? 'bg-red-500'
      : 'bg-slate-900'

  return (
    <li className="py-2.5" style={{ paddingLeft: depth * 20 }}>
      <div className="flex items-center gap-2.5 text-sm">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: category.color }}
        />
        <span className="font-medium text-slate-800">{category.name}</span>
        <span className="ml-auto tabular-nums">
          <span
            className={
              over
                ? 'font-medium text-red-600'
                : 'font-medium text-slate-800'
            }
          >
            {formatDuration(assigned)}
          </span>
          <span className="text-slate-400">
            {' / '}
            {unbudgeted ? 'unbudgeted' : formatDuration(allocated)}
          </span>
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full ${fill} transition-all`}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-400">
          {pct === null ? '—' : `${pct}%`}
        </span>
      </div>
    </li>
  )
}
