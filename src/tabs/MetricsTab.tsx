import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import type { BudgetType } from '../db'
import BudgetProgress from '../components/BudgetProgress'
import DateRangePicker from '../components/DateRangePicker'
import { categoryMap } from '../lib/categories'
import { resolveBudget } from '../lib/budget'
import { formatDuration, isoDate, parseIsoDate } from '../lib/time'

/** One block of categorized past time is 30 minutes. */
const BLOCK_MINUTES = 30

/** View id for the all-time pie chart; budget views use the budget's id. */
const OVERVIEW = 'overview'

/**
 * How many rings the DaisyDisk-style chart shows: the center plus three
 * subcategory shells. Categories nested deeper render once you drill in.
 */
const RING_COUNT = 4

/** Fallback slice color for categories with no color set. */
const FALLBACK_COLOR = '#cbd5e1'

/** A node in the aggregated minutes tree; `minutes` is the whole subtree. */
type Node = { id: string; minutes: number; children: Map<string, Node> }

export default function MetricsTab() {
  const categories = useLiveQuery(() => db.categories.toArray(), [])
  const blocks = useLiveQuery(() => db.blocks.toArray(), [])
  const budgets = useLiveQuery(() => db.budgets.toArray(), [])

  /** Top-level tab: overview, or one of the budget kinds. */
  const [top, setTop] = useState<typeof OVERVIEW | BudgetType>(OVERVIEW)
  /** Selected budget id within the current kind. */
  const [budgetId, setBudgetId] = useState<string | null>(null)
  /** Drilled-into category id, or null for the all-categories view. */
  const [focusId, setFocusId] = useState<string | null>(null)
  /** Overview date filter, inclusive ISO dates; empty strings mean no filter. */
  const [rangeStart, setRangeStart] = useState<string>('')
  const [rangeEnd, setRangeEnd] = useState<string>('')
  /** Overview budget filter; empty means no budget restriction. */
  const [budgetFilterIds, setBudgetFilterIds] = useState<string[]>([])

  // Blocks restricted to the Overview filters (date range and/or budget).
  const filteredBlocks = useMemo(() => {
    if (!blocks) return blocks
    const hasRange = !!(rangeStart && rangeEnd)
    const hasBudget = budgetFilterIds.length > 0 && !!budgets
    if (!hasRange && !hasBudget) return blocks
    const lo = hasRange ? parseIsoDate(rangeStart).getTime() : -Infinity
    const hi = hasRange ? parseIsoDate(rangeEnd).getTime() + 86_400_000 : Infinity
    const selected = new Set(budgetFilterIds)
    const dayCache = new Map<string, boolean>()
    const dayMatchesBudget = (start: number) => {
      const iso = isoDate(new Date(start))
      const hit = dayCache.get(iso)
      if (hit !== undefined) return hit
      const id = resolveBudget(budgets ?? [], iso)?.id
      const ok = !!id && selected.has(id)
      dayCache.set(iso, ok)
      return ok
    }
    return blocks.filter((b) => {
      if (b.start < lo || b.start >= hi) return false
      if (hasBudget && !dayMatchesBudget(b.start)) return false
      return true
    })
  }, [blocks, budgets, rangeStart, rangeEnd, budgetFilterIds])

  const visibleBudgets = useMemo(() => {
    if (top === OVERVIEW) return []
    const list = (budgets ?? []).filter((b) => b.type === top)
    return top === 'oneoff'
      ? list.sort((a, b) => {
          const aDate = a.startDate ?? ''
          const bDate = b.startDate ?? ''
          if (aDate !== bDate) return aDate.localeCompare(bDate)
          return a.createdAt - b.createdAt
        })
      : list.sort((a, b) => a.createdAt - b.createdAt)
  }, [budgets, top])

  // Keep the selected budget in sync with the active kind: clear it on
  // Overview, or fall back to the first budget when none is selected or the
  // current selection doesn't belong to this kind.
  useEffect(() => {
    if (top === OVERVIEW) {
      if (budgetId !== null) setBudgetId(null)
      return
    }
    const match = visibleBudgets.find((b) => b.id === budgetId)
    if (!match) setBudgetId(visibleBudgets[0]?.id ?? null)
  }, [top, visibleBudgets, budgetId])

  const catById = useMemo(() => categoryMap(categories ?? []), [categories])

  // Root-first chain of ancestor ids for a category, uncapped in depth.
  const chainOf = useMemo(() => {
    const cache = new Map<string, string[]>()
    return (id: string): string[] => {
      const hit = cache.get(id)
      if (hit) return hit
      const chain: string[] = []
      let cur = catById.get(id)
      while (cur) {
        chain.push(cur.id)
        cur = cur.parentId ? catById.get(cur.parentId) : undefined
      }
      chain.reverse()
      if (chain.length === 0) chain.push(id)
      cache.set(id, chain)
      return chain
    }
  }, [catById])

  // Aggregate every block into a nested tree of minutes. The top-level Map
  // holds the roots; each node's `minutes` covers its entire subtree.
  const { tree, total } = useMemo(() => {
    const roots = new Map<string, Node>()
    const get = (level: Map<string, Node>, id: string): Node => {
      let n = level.get(id)
      if (!n) {
        n = { id, minutes: 0, children: new Map() }
        level.set(id, n)
      }
      return n
    }
    for (const b of filteredBlocks ?? []) {
      let level = roots
      for (const id of chainOf(b.categoryId)) {
        const node = get(level, id)
        node.minutes += BLOCK_MINUTES
        level = node.children
      }
    }
    let total = 0
    for (const r of roots.values()) total += r.minutes
    return { tree: roots, total }
  }, [filteredBlocks, chainOf])

  // The tree node currently drilled into, or null when showing all roots.
  const focusNode = useMemo(() => {
    if (!focusId) return null
    let level = tree
    let node: Node | undefined
    for (const id of chainOf(focusId)) {
      node = level.get(id)
      if (!node) return null
      level = node.children
    }
    return node ?? null
  }, [focusId, tree, chainOf])

  // Flatten the focused subtree into one ordered slice list per ring. Slices
  // are emitted depth-first, descending-size, so each subcategory sits
  // angularly under its parent across all rings.
  const { rings, lastRealRing, focusTotal } = useMemo(() => {
    const rings: OuterSlice[][] = Array.from({ length: RING_COUNT }, () => [])

    const emit = (
      id: string,
      value: number,
      depth: number,
      key: string,
      color: string,
      dim: boolean,
      node: Node | null,
    ) => {
      const name = catById.get(id)?.name ?? 'Unknown'
      rings[depth].push({
        id: key,
        catId: id,
        name: dim ? `${name} (direct)` : name,
        color,
        value,
        dim,
        // Any real category can be drilled into; the focused category sits
        // in the center already, so it is not itself clickable.
        clickable: !dim && id !== focusId,
      })
      if (depth + 1 >= RING_COUNT) return
      // A faded "direct" slice has no breakdown — repeat it faded outward.
      if (dim || !node) {
        emit(id, value, depth + 1, `${key}/=`, color, true, null)
        return
      }
      const kids = [...node.children.values()].sort(
        (a, b) => b.minutes - a.minutes,
      )
      let childSum = 0
      for (const kid of kids) {
        childSum += kid.minutes
        emit(
          kid.id,
          kid.minutes,
          depth + 1,
          `${key}/${kid.id}`,
          catById.get(kid.id)?.color ?? FALLBACK_COLOR,
          false,
          kid,
        )
      }
      // Whatever is not covered by children is time logged on the node itself.
      const direct = value - childSum
      if (direct > 1e-6) {
        emit(id, direct, depth + 1, `${key}/direct`, color, true, null)
      }
    }

    const focusTotal = focusNode ? focusNode.minutes : total

    if (focusNode) {
      // The focused category is a solid center disk; the shells break it down.
      emit(
        focusNode.id,
        focusNode.minutes,
        0,
        focusNode.id,
        catById.get(focusNode.id)?.color ?? FALLBACK_COLOR,
        false,
        focusNode,
      )
    } else {
      // Unfocused: the center ring is the top-level categories themselves.
      for (const kid of [...tree.values()].sort(
        (a, b) => b.minutes - a.minutes,
      )) {
        emit(
          kid.id,
          kid.minutes,
          0,
          kid.id,
          catById.get(kid.id)?.color ?? FALLBACK_COLOR,
          false,
          kid,
        )
      }
    }

    let lastRealRing = 0
    for (let d = 1; d < RING_COUNT; d++) {
      if (rings[d].some((s) => !s.dim)) lastRealRing = d
    }
    return { rings, lastRealRing, focusTotal }
  }, [focusNode, focusId, tree, total, catById])

  // Breadcrumb trail from "All" down to the focused category.
  const crumbs = useMemo(
    () =>
      (focusId ? chainOf(focusId) : []).map((id) => ({
        id,
        name: catById.get(id)?.name ?? 'Unknown',
      })),
    [focusId, chainOf, catById],
  )

  if (!categories || !blocks || !budgets) {
    return <div className="text-slate-400">Loading…</div>
  }

  return (
    <div>
      {/* Top-level tabs: Overview, Recurring, One-off. */}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        <ViewTab
          label="Overview"
          active={top === OVERVIEW}
          onClick={() => setTop(OVERVIEW)}
        />
        <ViewTab
          label="Recurring"
          active={top === 'recurring'}
          onClick={() => setTop('recurring')}
        />
        <ViewTab
          label="One-off"
          active={top === 'oneoff'}
          onClick={() => setTop('oneoff')}
        />
      </div>

      {/* Second-row tabs: one per budget in the selected kind. */}
      {top !== OVERVIEW && (
        <div className="mb-6 flex flex-wrap gap-1 border-b border-slate-200">
          {visibleBudgets.length === 0 ? (
            <div className="px-3.5 py-2 text-sm text-slate-400">
              No {top === 'recurring' ? 'recurring' : 'one-off'} budgets yet.
            </div>
          ) : (
            visibleBudgets.map((b) => (
              <ViewTab
                key={b.id}
                label={b.name}
                active={budgetId === b.id}
                onClick={() => setBudgetId(b.id)}
              />
            ))
          )}
        </div>
      )}

      {top === OVERVIEW ? (
        <Overview
          rings={rings}
          ringCount={lastRealRing + 1}
          total={focusTotal}
          crumbs={crumbs}
          onFocus={setFocusId}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          onRangeChange={(s, e) => {
            setRangeStart(s)
            setRangeEnd(e)
          }}
          onRangeClear={() => {
            setRangeStart('')
            setRangeEnd('')
          }}
          budgets={budgets}
          budgetFilterIds={budgetFilterIds}
          onBudgetFilterChange={setBudgetFilterIds}
        />
      ) : (
        (() => {
          const budget = visibleBudgets.find((b) => b.id === budgetId)
          if (!budget) return null
          return (
            <BudgetProgress
              budget={budget}
              budgets={budgets}
              categories={categories}
              blocks={blocks}
            />
          )
        })()
      )}
    </div>
  )
}

/** A single tab in the Metrics view strip. */
function ViewTab({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-3.5 py-2 text-sm font-medium transition-colors ${
        active
          ? 'border-slate-900 text-slate-900'
          : 'border-transparent text-slate-500 hover:text-slate-800'
      }`}
    >
      {label}
    </button>
  )
}

type Slice = { id: string; name: string; color: string; value: number }
/**
 * A ring slice. `dim` marks time logged directly on the parent; `clickable`
 * means the slice has a breakdown you can drill into; `catId` is the real
 * category id (distinct from `id`, which is a unique per-ring path key).
 */
type OuterSlice = Slice & { dim: boolean; clickable: boolean; catId: string }

/** Largest ring radius, in px, that fits the 384px (h-96/w-96) chart box. */
const MAX_RADIUS = 178
/** Gap between concentric rings, in px. */
const RING_GAP = 6

/**
 * Inner/outer radius for ring `depth` when `ringCount` rings are drawn. Bands
 * are weighted so the center disk is widest and each shell is thinner than
 * the one inside it.
 */
function ringRadii(depth: number, ringCount: number) {
  const available = MAX_RADIUS - RING_GAP * (ringCount - 1)
  const weights = Array.from({ length: ringCount }, (_, d) => ringCount - d)
  const total = weights.reduce((a, b) => a + b, 0)
  const width = (d: number) => (available * weights[d]) / total
  let innerRadius = 0
  for (let d = 0; d < depth; d++) innerRadius += width(d) + RING_GAP
  return { innerRadius, outerRadius: innerRadius + width(depth) }
}

/** The all-time DaisyDisk-style chart of time across nested categories. */
function Overview({
  rings,
  ringCount,
  total,
  crumbs,
  onFocus,
  rangeStart,
  rangeEnd,
  onRangeChange,
  onRangeClear,
  budgets,
  budgetFilterIds,
  onBudgetFilterChange,
}: {
  rings: OuterSlice[][]
  ringCount: number
  total: number
  crumbs: { id: string; name: string }[]
  onFocus: (id: string | null) => void
  rangeStart: string
  rangeEnd: string
  onRangeChange: (start: string, end: string) => void
  onRangeClear: () => void
  budgets: import('../db').Budget[]
  budgetFilterIds: string[]
  onBudgetFilterChange: (ids: string[]) => void
}) {
  const filtered = !!(rangeStart && rangeEnd)
  const slices = rings[0]
  const focused = crumbs.length > 0
  // When focused, the center is the category itself — list its breakdown
  // (the first shell) in the legend rather than the lone center slice.
  const legendSlices = focused && rings[1].length > 0 ? rings[1] : slices

  function setTrailingDays(n: number) {
    const today = new Date()
    const start = new Date(today)
    start.setDate(start.getDate() - (n - 1))
    onRangeChange(isoDate(start), isoDate(today))
  }

  const picker = (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-1">
        <DateRangePicker
          start={rangeStart}
          end={rangeEnd}
          onChange={onRangeChange}
          align="right"
        />
        <PresetButton onClick={() => setTrailingDays(7)}>Last week</PresetButton>
        <PresetButton onClick={() => setTrailingDays(30)}>Last month</PresetButton>
        {filtered && (
          <button
            type="button"
            onClick={onRangeClear}
            className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            All time
          </button>
        )}
      </div>
      <BudgetFilterPicker
        budgets={budgets}
        selected={budgetFilterIds}
        onChange={onBudgetFilterChange}
      />
    </div>
  )

  if (slices.length === 0) {
    return (
      <div>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Time allocation
            </h2>
            <p className="text-sm text-slate-500">
              {filtered ? 'No categorized time in this range.' : null}
            </p>
          </div>
          {picker}
        </div>
        <div className="rounded-xl border border-dashed border-slate-300 px-6 py-16 text-center text-sm text-slate-400">
          No categorized time here yet — categorize some blocks to see where it
          goes.
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Time allocation
          </h2>
          <p className="text-sm text-slate-500">
            {formatDuration(total)}
            {crumbs.length > 0 ? ` in ${crumbs[crumbs.length - 1].name}` : ''} ·
            click a slice to drill in.
          </p>
        </div>
        {picker}
      </div>

      {/* Breadcrumb trail; each crumb pops the drill-down back to that level. */}
      <div className="mb-5 flex flex-wrap items-center gap-1 text-sm">
        <Crumb label="All categories" onClick={() => onFocus(null)} />
        {crumbs.map((c) => (
          <span key={c.id} className="flex items-center gap-1">
            <span className="text-slate-300">/</span>
            <Crumb label={c.name} onClick={() => onFocus(c.id)} />
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-8">
        <DaisyChart
          rings={rings}
          ringCount={ringCount}
          total={total}
          onDrill={onFocus}
        />

        <ul className="min-w-48 space-y-2">
          {legendSlices.map((s) => (
            <li key={s.id} className="flex items-center gap-2.5 text-sm">
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: s.color, opacity: s.dim ? 0.4 : 1 }}
              />
              {s.clickable ? (
                <button
                  type="button"
                  onClick={() => onFocus(s.catId)}
                  className="font-medium text-slate-800 hover:text-slate-900 hover:underline"
                >
                  {s.name}
                </button>
              ) : (
                <span className="font-medium text-slate-800">{s.name}</span>
              )}
              <span className="ml-auto pl-4 tabular-nums text-slate-500">
                {formatDuration(s.value)}
              </span>
              <span className="w-10 shrink-0 text-right tabular-nums text-slate-400">
                {Math.round((s.value / total) * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * Multi-select budget filter. Trigger button styled like the date picker;
 * popover lists recurring budgets at the top with one-offs collapsed into
 * a submenu. Pending selection commits on Accept.
 */
function BudgetFilterPicker({
  budgets,
  selected,
  onChange,
}: {
  budgets: import('../db').Budget[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<Set<string>>(new Set(selected))
  const [showOneoffs, setShowOneoffs] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const recurring = useMemo(
    () =>
      budgets
        .filter((b) => b.type === 'recurring')
        .sort((a, b) => a.createdAt - b.createdAt),
    [budgets],
  )
  const oneoffs = useMemo(
    () =>
      budgets
        .filter((b) => b.type === 'oneoff')
        .sort((a, b) => {
          const aDate = a.startDate ?? ''
          const bDate = b.startDate ?? ''
          if (aDate !== bDate) return aDate.localeCompare(bDate)
          return a.createdAt - b.createdAt
        }),
    [budgets],
  )

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function openPicker() {
    setPending(new Set(selected))
    setShowOneoffs(oneoffs.some((b) => selected.includes(b.id)))
    setOpen(true)
  }

  function toggle(id: string) {
    setPending((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function commit() {
    onChange([...pending])
    setOpen(false)
  }

  const label = useMemo(() => {
    if (selected.length === 0) return 'All budgets'
    if (selected.length === 1) {
      const b = budgets.find((x) => x.id === selected[0])
      return b ? b.name : '1 budget'
    }
    return `${selected.length} budgets`
  }, [selected, budgets])

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
        <BudgetIcon />
        <span>{label}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
          {recurring.length === 0 && oneoffs.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-slate-400">
              No budgets yet.
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {recurring.map((b) => (
                <BudgetOption
                  key={b.id}
                  label={b.name}
                  checked={pending.has(b.id)}
                  onToggle={() => toggle(b.id)}
                />
              ))}
              {oneoffs.length > 0 && (
                <li>
                  <button
                    type="button"
                    onClick={() => setShowOneoffs((v) => !v)}
                    className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-50"
                  >
                    <Caret open={showOneoffs} />
                    One-off
                  </button>
                  {showOneoffs && (
                    <ul className="ml-3 border-l border-slate-100 pl-1">
                      {oneoffs.map((b) => (
                        <BudgetOption
                          key={b.id}
                          label={b.name}
                          checked={pending.has(b.id)}
                          onToggle={() => toggle(b.id)}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              )}
            </ul>
          )}
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-slate-100 pt-2">
            <button
              type="button"
              onClick={() => setPending(new Set())}
              className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            >
              Clear
            </button>
            <div className="flex items-center gap-1">
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
                className="rounded-md bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800"
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

function BudgetOption({
  label,
  checked,
  onToggle,
}: {
  label: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-800 hover:bg-slate-50">
        <span
          className={
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ' +
            (checked ? 'border-slate-900 bg-slate-900' : 'border-slate-300 bg-white')
          }
        >
          {checked && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
        </span>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="sr-only"
        />
        <span className="truncate">{label}</span>
      </label>
    </li>
  )
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={'transition-transform ' + (open ? 'rotate-90' : '')}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function BudgetIcon() {
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
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  )
}

function PresetButton({
  children,
  onClick,
}: {
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-slate-300 hover:text-slate-900"
    >
      {children}
    </button>
  )
}

/** A clickable breadcrumb segment. */
function Crumb({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-1.5 py-0.5 font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
    >
      {label}
    </button>
  )
}

/** Pixel size of the square chart (matches the old h-96/w-96 box). */
const CHART_SIZE = 384
/** Center coordinate of the chart. */
const CENTER = CHART_SIZE / 2
/** Duration of the re-center morph, in ms. */
const MORPH_MS = 520

/** A slice laid out as an absolute annular sector. */
type Laid = {
  key: string
  slice: OuterSlice
  startAngle: number
  endAngle: number
  innerR: number
  outerR: number
}
/** A laid-out slice mid-transition, carrying an animated opacity. */
type Frame = Laid & { opacity: number }

/** easeInOutCubic — slow at both ends, brisk through the middle. */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** Lay every ring out as absolute sectors; each ring spans the full circle. */
function layout(
  rings: OuterSlice[][],
  ringCount: number,
  total: number,
): Laid[] {
  const out: Laid[] = []
  for (let depth = 0; depth < ringCount; depth++) {
    const { innerRadius, outerRadius } = ringRadii(depth, ringCount)
    let angle = 0
    for (const s of rings[depth]) {
      const span = total > 0 ? (s.value / total) * 360 : 0
      out.push({
        // Real categories key on their id so they morph across states;
        // faded "direct" slices get a unique key and simply fade.
        key: s.dim ? `dim:${s.id}` : s.catId,
        slice: s,
        startAngle: angle,
        endAngle: angle + span,
        innerR: innerRadius,
        outerR: outerRadius,
      })
      angle += span
    }
  }
  return out
}

/** Point on a circle, with 0° at twelve o'clock and angles going clockwise. */
function polar(r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180
  return [CENTER + r * Math.cos(a), CENTER + r * Math.sin(a)]
}

/** A full circle (or, reversed, a hole) as an SVG path. */
function circlePath(r: number, reverse = false): string {
  const sweep = reverse ? 0 : 1
  return `M ${CENTER},${CENTER - r} A ${r},${r} 0 1 ${sweep} ${CENTER},${
    CENTER + r
  } A ${r},${r} 0 1 ${sweep} ${CENTER},${CENTER - r} Z`
}

/** SVG path for one annular sector, with seamless handling of full rings. */
function sectorPath(
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number,
): string {
  const span = endAngle - startAngle
  if (span <= 0.01) return ''
  // A full ring drawn as one arc would not close — use circles instead.
  if (span >= 359.99) {
    return innerR <= 0.5
      ? circlePath(outerR)
      : `${circlePath(outerR)} ${circlePath(innerR, true)}`
  }
  const large = span > 180 ? 1 : 0
  const [ox1, oy1] = polar(outerR, startAngle)
  const [ox2, oy2] = polar(outerR, endAngle)
  if (innerR <= 0.5) {
    return `M ${CENTER},${CENTER} L ${ox1},${oy1} A ${outerR},${outerR} 0 ${large} 1 ${ox2},${oy2} Z`
  }
  const [ix1, iy1] = polar(innerR, startAngle)
  const [ix2, iy2] = polar(innerR, endAngle)
  return `M ${ox1},${oy1} A ${outerR},${outerR} 0 ${large} 1 ${ox2},${oy2} L ${ix2},${iy2} A ${innerR},${innerR} 0 ${large} 0 ${ix1},${iy1} Z`
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * The DaisyDisk-style chart. When the focus changes, slices morph from their
 * old layout to the new one — persistent categories sweep around to fill the
 * circle and slide toward the center, while departing slices fade out.
 */
function DaisyChart({
  rings,
  ringCount,
  total,
  onDrill,
}: {
  rings: OuterSlice[][]
  ringCount: number
  total: number
  onDrill: (id: string | null) => void
}) {
  const target = useMemo(
    () => layout(rings, ringCount, total),
    [rings, ringCount, total],
  )

  const [frame, setFrame] = useState<Frame[]>(() =>
    target.map((l) => ({ ...l, opacity: 1 })),
  )
  // Mirrors the latest rendered frame so an interrupted morph resumes from it.
  const frameRef = useRef<Frame[]>(frame)
  const rafRef = useRef<number | undefined>(undefined)
  const firstRef = useRef(true)

  const [hover, setHover] = useState<{
    slice: OuterSlice
    x: number
    y: number
  } | null>(null)

  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false
      return
    }
    const from = frameRef.current
    const fromMap = new Map(from.map((s) => [s.key, s]))
    const toMap = new Map(target.map((s) => [s.key, s]))
    const keys = [...new Set([...fromMap.keys(), ...toMap.keys()])]

    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / MORPH_MS)
      const e = ease(t)
      const next: Frame[] = []
      for (const key of keys) {
        const a = fromMap.get(key)
        const b = toMap.get(key)
        if (a && b) {
          next.push({
            key,
            slice: b.slice,
            startAngle: lerp(a.startAngle, b.startAngle, e),
            endAngle: lerp(a.endAngle, b.endAngle, e),
            innerR: lerp(a.innerR, b.innerR, e),
            outerR: lerp(a.outerR, b.outerR, e),
            opacity: 1,
          })
        } else if (a) {
          next.push({ ...a, opacity: 1 - e })
        } else if (b) {
          next.push({ ...b, opacity: e })
        }
      }
      // On the final frame, settle to the clean target so faded-out
      // departing slices are dropped entirely (no lingering hit targets).
      const settled = t < 1 ? next : target.map((l) => ({ ...l, opacity: 1 }))
      frameRef.current = settled
      setFrame(settled)
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [target])

  // Center disk first so outer shells paint on top during the morph.
  const ordered = [...frame].sort((a, b) => a.innerR - b.innerR)

  return (
    <div className="relative h-96 w-96 shrink-0">
      <svg
        viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`}
        className="h-full w-full"
        onMouseLeave={() => setHover(null)}
      >
        {ordered.map((f) => {
          const d = sectorPath(f.innerR, f.outerR, f.startAngle, f.endAngle)
          if (!d) return null
          return (
            <path
              key={f.key}
              d={d}
              fill={f.slice.color}
              fillOpacity={f.slice.dim ? 0.4 : 1}
              fillRule="evenodd"
              stroke="#fff"
              strokeWidth={2}
              opacity={f.opacity}
              style={{
                cursor: f.slice.clickable ? 'pointer' : 'default',
                // Mid-morph slices must not steal hover from the real chart.
                pointerEvents: f.opacity > 0.999 ? 'auto' : 'none',
              }}
              onClick={() => f.slice.clickable && onDrill(f.slice.catId)}
              onMouseMove={(ev) => {
                const box = ev.currentTarget.ownerSVGElement?.getBoundingClientRect()
                setHover({
                  slice: f.slice,
                  x: ev.clientX - (box?.left ?? 0),
                  y: ev.clientY - (box?.top ?? 0),
                })
              }}
            />
          )
        })}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow-lg"
          style={{ left: hover.x, top: hover.y - 8 }}
        >
          <span className="font-medium">{hover.slice.name}</span>{' '}
          <span className="text-slate-300">
            {formatDuration(hover.slice.value)} ·{' '}
            {Math.round((hover.slice.value / total) * 100)}%
          </span>
        </div>
      )}
    </div>
  )
}
