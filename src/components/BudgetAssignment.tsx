import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, mutate } from '../db'
import type { Budget, Category } from '../db'
import { categoryMap, indentCategories } from '../lib/categories'
import { formatDuration, formatTimeOfDay } from '../lib/time'

interface BudgetAssignmentProps {
  budget: Budget
}

/**
 * Category assignment for a budget — set minutes-per-period for each
 * category. Allocations sum against the budget's coverage window.
 */
export default function BudgetAssignment({ budget }: BudgetAssignmentProps) {
  // Categories opened for allocation but not yet given committed time.
  const [pending, setPending] = useState<Set<string>>(new Set())
  // The single category row currently being edited.
  const [editingId, setEditingId] = useState<string | null>(null)

  const categories = useLiveQuery(
    () => db.categories.where('eraId').equals(budget.eraId).toArray(),
    [budget.eraId],
  )
  const allocations = useLiveQuery(
    () => db.budgetAllocations.where('budgetId').equals(budget.id).toArray(),
    [budget.id],
  )

  const tree = useMemo(
    () => indentCategories(categories ?? []),
    [categories],
  )
  const minutesByCategory = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of allocations ?? []) map.set(a.categoryId, a.minutes)
    return map
  }, [allocations])

  // Direct children of each category id, keyed by parent id ('' = top level).
  const childIds = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const c of categories ?? []) {
      const arr = map.get(c.parentId ?? '') ?? []
      arr.push(c.id)
      map.set(c.parentId ?? '', arr)
    }
    return map
  }, [categories])

  // For each category, the total minutes allocated across all of its
  // descendants (not counting any time allocated directly to itself).
  const subtotalByCategory = useMemo(() => {
    const memo = new Map<string, number>()
    const compute = (id: string): number => {
      const cached = memo.get(id)
      if (cached !== undefined) return cached
      let total = 0
      for (const child of childIds.get(id) ?? []) {
        total += (minutesByCategory.get(child) ?? 0) + compute(child)
      }
      memo.set(id, total)
      return total
    }
    for (const c of categories ?? []) compute(c.id)
    return memo
  }, [childIds, minutesByCategory, categories])

  // The pool is the whole period: coverage hours × the number of days the
  // budget applies to (e.g. 9–5 Mon–Fri ⇒ 8h × 5 = 40h per week).
  const coverPerDay = budget.coverEnd - budget.coverStart
  const dayCount =
    budget.recurrence === 'monthly'
      ? budget.monthDays.length
      : budget.weekdays.length
  const periodLabel = budget.recurrence === 'monthly' ? 'month' : 'week'
  const periodMinutes = coverPerDay * dayCount
  const allocatedPeriod = (allocations ?? []).reduce(
    (sum, a) => sum + a.minutes,
    0,
  )

  // Allocations are always stored as period totals. In daily mode we divide
  // by the day count for display and multiply back on commit, so toggling
  // the mode never changes what's stored.
  const mode = budget.allocationMode
  const divisor = dayCount || 1
  /** Convert a stored period total into the value shown for the current mode. */
  const toDisplay = (periodMin: number) =>
    mode === 'daily' ? Math.round(periodMin / divisor) : periodMin
  /** Convert an edited value back into a stored period total. */
  const toPeriod = (displayMin: number) =>
    mode === 'daily' ? displayMin * divisor : displayMin

  // The summary totals, expressed in the units of the current mode.
  const pool = mode === 'daily' ? coverPerDay : periodMinutes
  const allocated = toDisplay(allocatedPeriod)
  const remaining = pool - allocated

  // Show categories with a direct allocation, any opened via the picker, and
  // any parent that has time allocated somewhere in its subtree.
  const shownIds = useMemo(() => {
    const ids = new Set<string>()
    for (const { category } of tree) {
      if (
        (minutesByCategory.get(category.id) ?? 0) > 0 ||
        pending.has(category.id) ||
        (subtotalByCategory.get(category.id) ?? 0) > 0
      ) {
        ids.add(category.id)
      }
    }
    return ids
  }, [tree, minutesByCategory, pending, subtotalByCategory])
  const shown = tree.filter(({ category }) => shownIds.has(category.id))

  /** Commit an edited allocation. The incoming value is in the current
   * mode's units; it is converted to a canonical period total for storage.
   * Zero removes it (and the row disappears). */
  async function commit(categoryId: string, displayMinutes: number) {
    const minutes = toPeriod(displayMinutes)
    const existing = await db.budgetAllocations
      .where({ budgetId: budget.id, categoryId })
      .first()
    await mutate(async () => {
      if (minutes <= 0) {
        if (existing) await db.budgetAllocations.delete(existing.id)
      } else if (existing) {
        await db.budgetAllocations.update(existing.id, { minutes })
      } else {
        await db.budgetAllocations.add({
          id: crypto.randomUUID(),
          budgetId: budget.id,
          categoryId,
          minutes,
        })
      }
    })
    if (minutes <= 0) {
      setPending((prev) => {
        if (!prev.has(categoryId)) return prev
        const next = new Set(prev)
        next.delete(categoryId)
        return next
      })
    }
    setEditingId(null)
  }

  if (tree.length === 0) {
    return (
      <div className="mt-6 rounded-lg border border-dashed border-slate-300 px-6 py-16 text-center text-sm text-slate-400">
        No categories yet — add some in the Categories library first.
      </div>
    )
  }

  const unit = mode === 'daily' ? 'day' : periodLabel

  return (
    <div className="mt-6">
      {/* Mode toggle: daily-per-day vs. whole-period totals */}
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-slate-500">
          {mode === 'daily'
            ? 'Allocating minutes per day — applied to every day of the period.'
            : 'Allocating totals for the whole period.'}
        </p>
        <div className="flex shrink-0 gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {(['daily', 'period'] as const).map((m) => (
            <button
              key={m}
              onClick={() =>
                void mutate(() =>
                  db.budgets.update(budget.id, { allocationMode: m }),
                )
              }
              className={
                'rounded-md px-3 py-1 text-xs font-medium transition-colors ' +
                (mode === m
                  ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                  : 'text-slate-500 hover:text-slate-900')
              }
            >
              {m === 'daily' ? 'Daily' : 'Period'}
            </button>
          ))}
        </div>
      </div>

      {/* Coverage summary */}
      <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg bg-slate-50 px-4 py-3 text-sm">
        <span className="text-slate-500">
          Covers{' '}
          <span className="font-medium text-slate-700">
            {formatTimeOfDay(budget.coverStart)} –{' '}
            {formatTimeOfDay(budget.coverEnd)}
          </span>{' '}
          · {dayCount} {dayCount === 1 ? 'day' : 'days'} ·{' '}
          <span className="font-medium text-slate-700">
            {formatDuration(pool)}
          </span>
          /{unit}
        </span>
        <span className="text-slate-500">
          Allocated{' '}
          <span className="font-medium text-slate-700">
            {formatDuration(allocated)}
          </span>
          /{unit}
        </span>
        <span
          className={
            'font-medium ' +
            (remaining < 0
              ? 'text-red-600'
              : remaining === 0
                ? 'text-emerald-600'
                : 'text-slate-700')
          }
        >
          {remaining < 0
            ? `⚠ Temporal anomaly — over by ${formatDuration(-remaining)}`
            : `${formatDuration(remaining)} unallocated`}
        </span>
      </div>

      {/* Per-category allocation rows */}
      <ul className="mt-2 divide-y divide-slate-100 border-y border-slate-100">
        {shown.length === 0 && (
          <li className="py-6 text-center text-sm text-slate-400">
            Nothing allocated yet — add a category below.
          </li>
        )}
        {shown.map(({ category, depth }) => (
          <AllocationRow
            key={category.id}
            category={category}
            depth={depth}
            minutes={toDisplay(minutesByCategory.get(category.id) ?? 0)}
            subtotal={toDisplay(subtotalByCategory.get(category.id) ?? 0)}
            isEditing={editingId === category.id}
            onSelect={() => setEditingId(category.id)}
            onCommit={(minutes) => commit(category.id, minutes)}
          />
        ))}
      </ul>

      <CategoryPicker
        categories={categories ?? []}
        shownIds={shownIds}
        onPick={(id) => {
          setPending((prev) => new Set(prev).add(id))
          setEditingId(id)
        }}
      />
    </div>
  )
}

interface CategoryPickerProps {
  categories: Category[]
  /** Categories already in the allocation list — shown as "Added". */
  shownIds: Set<string>
  onPick: (id: string) => void
}

/**
 * Drill-down category chooser. Opens at the top-level categories; clicking a
 * category with children descends into them. A category with children is also
 * listed at the top of its own sublevel so it can be picked directly.
 */
function CategoryPicker({ categories, shownIds, onPick }: CategoryPickerProps) {
  const [open, setOpen] = useState(false)
  // Ids from root to the currently-viewed category ([] = top level).
  const [path, setPath] = useState<string[]>([])
  const ref = useRef<HTMLDivElement>(null)

  const byId = useMemo(() => categoryMap(categories), [categories])
  const childrenOf = useMemo(() => {
    const map = new Map<string, Category[]>()
    for (const c of categories) {
      const key = c.parentId ?? ''
      const arr = map.get(key) ?? []
      arr.push(c)
      map.set(key, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => a.order - b.order)
    return map
  }, [categories])

  // Close when clicking outside the picker.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setPath([])
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const currentId = path[path.length - 1] ?? ''
  const currentCat = currentId ? byId.get(currentId) : null
  const children = childrenOf.get(currentId) ?? []

  function pick(id: string) {
    onPick(id)
    setOpen(false)
    setPath([])
  }

  function row(c: Category) {
    const kids = childrenOf.get(c.id) ?? []
    const added = shownIds.has(c.id)
    if (kids.length > 0) {
      return (
        <button
          key={c.id}
          onClick={() => setPath((p) => [...p, c.id])}
          className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-slate-50"
        >
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: c.color }}
          />
          <span className="font-medium text-slate-800">{c.name}</span>
          <span className="ml-auto text-slate-300">›</span>
        </button>
      )
    }
    return (
      <button
        key={c.id}
        disabled={added}
        onClick={() => pick(c.id)}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-slate-50 disabled:cursor-default disabled:opacity-40"
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: c.color }}
        />
        <span className="font-medium text-slate-800">{c.name}</span>
        {added && (
          <span className="ml-auto text-xs text-slate-400">Added</span>
        )}
      </button>
    )
  }

  return (
    <div ref={ref} className="relative mt-3 inline-block">
      <button
        onClick={() => {
          setOpen((o) => !o)
          setPath([])
        }}
        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
      >
        + Add a category…
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-72 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {currentCat ? (
            <>
              <button
                onClick={() => setPath((p) => p.slice(0, -1))}
                className="flex w-full items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:text-slate-700"
              >
                ‹ Back
              </button>
              <button
                disabled={shownIds.has(currentCat.id)}
                onClick={() => pick(currentCat.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-slate-50 disabled:cursor-default disabled:opacity-40"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: currentCat.color }}
                />
                <span className="font-medium text-slate-800">
                  {currentCat.name}
                </span>
                <span className="ml-auto text-xs text-slate-400">
                  {shownIds.has(currentCat.id) ? 'Added' : 'Allocate here'}
                </span>
              </button>
              <div className="my-1 h-px bg-slate-100" />
            </>
          ) : (
            <div className="px-3 py-1.5 text-xs font-medium text-slate-400">
              Choose a category
            </div>
          )}

          {children.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-400">
              No subcategories.
            </div>
          ) : (
            children.map(row)
          )}
        </div>
      )}
    </div>
  )
}

interface AllocationRowProps {
  category: Category
  depth: number
  /** Minutes allocated directly to this category. */
  minutes: number
  /** Minutes allocated across this category's descendants. */
  subtotal: number
  isEditing: boolean
  onSelect: () => void
  onCommit: (minutes: number) => void
}

/** One category's allocation — a static row, or a selected edit row that
 * commits on Enter or via the accept button. */
function AllocationRow({
  category,
  depth,
  minutes,
  subtotal,
  isEditing,
  onSelect,
  onCommit,
}: AllocationRowProps) {
  const [hours, setHours] = useState(Math.floor(minutes / 60))
  const [mins, setMins] = useState(minutes % 60)

  // Seed the draft from the committed value each time editing begins.
  useEffect(() => {
    if (isEditing) {
      setHours(Math.floor(minutes / 60))
      setMins(minutes % 60)
    }
  }, [isEditing, minutes])

  if (!isEditing) {
    return (
      <li
        onClick={onSelect}
        className="flex cursor-pointer items-center gap-2.5 py-2 text-sm transition-colors hover:bg-slate-50"
        style={{ paddingLeft: depth * 20 }}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: category.color }}
        />
        <span className="font-medium text-slate-800">{category.name}</span>
        <span className="ml-auto text-right text-sm tabular-nums">
          {subtotal > 0 ? (
            <span className="flex flex-col items-end leading-tight">
              <span className="font-medium text-slate-800">
                {formatDuration(minutes + subtotal)}
              </span>
              <span className="text-xs font-normal text-slate-400">
                {formatDuration(subtotal)} in subcategories
                {minutes > 0
                  ? ` · ${formatDuration(minutes)} direct`
                  : ''}
              </span>
            </span>
          ) : minutes > 0 ? (
            <span className="text-slate-500">{formatDuration(minutes)}</span>
          ) : (
            <span className="italic text-slate-400">Set time</span>
          )}
        </span>
      </li>
    )
  }

  return (
    <li
      className="flex items-center gap-2.5 rounded-md bg-slate-50 py-2 text-sm ring-1 ring-inset ring-slate-300"
      style={{ paddingLeft: depth * 20 }}
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: category.color }}
      />
      <span className="font-medium text-slate-800">{category.name}</span>
      {subtotal > 0 && (
        <span className="text-xs text-slate-400">
          direct time · {formatDuration(subtotal)} in subcategories
        </span>
      )}
      <div className="ml-auto flex items-center gap-1.5 pr-1">
        <input
          autoFocus
          type="number"
          min={0}
          step={1}
          value={hours || ''}
          placeholder="0"
          onChange={(e) =>
            setHours(Math.max(0, Math.round(Number(e.target.value) || 0)))
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit(hours * 60 + mins)
          }}
          className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-slate-500"
        />
        <span className="text-xs text-slate-400">h</span>
        <input
          type="number"
          min={0}
          max={59}
          step={5}
          value={mins || ''}
          placeholder="0"
          onChange={(e) =>
            setMins(
              Math.min(59, Math.max(0, Math.round(Number(e.target.value) || 0))),
            )
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit(hours * 60 + mins)
          }}
          className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-slate-500"
        />
        <span className="text-xs text-slate-400">m</span>
        <button
          onClick={() => onCommit(hours * 60 + mins)}
          aria-label="Accept allocation"
          className="grid h-7 w-7 place-items-center rounded-lg bg-slate-900 text-white transition-colors hover:bg-slate-700"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        </button>
      </div>
    </li>
  )
}
