import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import DaySelector from '../components/DaySelector'
import { db } from '../db'
import type { Block, BudgetAllocation, Category } from '../db'
import {
  categoryMap,
  indentCategories,
  type IndentedCategory,
} from '../lib/categories'
import { budgetPeriod, periodCoveredDays, resolveBudget } from '../lib/budget'
import {
  BLOCK_MS,
  dayBlockStarts,
  formatBlockTime,
  formatDuration,
  isBlockPast,
  isoDate,
  parseIsoDate,
} from '../lib/time'

/** A contiguous span of past blocks, either all uncategorized or all not. */
type Segment =
  | { kind: 'run'; starts: number[] }
  | { kind: 'gap'; starts: number[] }

export default function TransactionsTab() {
  const [iso, setIso] = useState(() => isoDate(new Date()))
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [showCategorized, setShowCategorized] = useState(false)
  // The single block whose category picker is open (with anchor coords).
  const [pickerFor, setPickerFor] = useState<{
    start: number
    x: number
    anchorTop: number
    anchorBottom: number
  } | null>(null)
  // The multi-select bar's category picker, anchored to its trigger button.
  const [bulkPicker, setBulkPicker] = useState<{
    x: number
    anchorTop: number
    anchorBottom: number
  } | null>(null)

  // A ticking "now" so future blocks become processable as time passes.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  // Reset selection whenever the day changes.
  useEffect(() => {
    setSelected(new Set())
    setAnchor(null)
    setPickerFor(null)
    setBulkPicker(null)
  }, [iso])

  // Close any open category picker on outside click or Escape.
  useEffect(() => {
    if (pickerFor === null && bulkPicker === null) return
    const close = () => {
      setPickerFor(null)
      setBulkPicker(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [pickerFor, bulkPicker])

  const starts = useMemo(() => dayBlockStarts(iso), [iso])

  const categories = useLiveQuery(() => db.categories.toArray(), [])
  const dayBlocks = useLiveQuery(
    () =>
      db.blocks
        .where('start')
        .between(starts[0], starts[starts.length - 1], true, true)
        .toArray(),
    [iso],
  )

  // The budget in effect for the viewed day drives "time left to assign".
  const budgets = useLiveQuery(() => db.budgets.toArray(), [])
  const activeBudget = useMemo(
    () => resolveBudget(budgets ?? [], iso),
    [budgets, iso],
  )
  const allocations = useLiveQuery(
    () =>
      activeBudget
        ? db.budgetAllocations
            .where('budgetId')
            .equals(activeBudget.id)
            .toArray()
        : Promise.resolve([] as BudgetAllocation[]),
    [activeBudget?.id],
  )

  // Allocations are minutes-per-period, so "time left" is tallied over the
  // whole budgeting period (week/month/one-off span), not just this day.
  const periodRange = useMemo(
    () => (activeBudget ? budgetPeriod(activeBudget, iso) : null),
    [activeBudget, iso],
  )
  const periodBlocks = useLiveQuery(() => {
    if (!periodRange) return Promise.resolve([] as Block[])
    const lo = parseIsoDate(periodRange.startIso).getTime()
    const hi = parseIsoDate(periodRange.endIso).getTime() + 24 * 60 * 60 * 1000
    return db.blocks.where('start').between(lo, hi, true, false).toArray()
  }, [periodRange?.startIso, periodRange?.endIso])

  const catList = useMemo(
    () => (categories ? indentCategories(categories) : []),
    [categories],
  )
  const catById = useMemo(
    () => categoryMap(categories ?? []),
    [categories],
  )
  const blockCategory = useMemo(() => {
    const map = new Map<number, string>()
    for (const b of dayBlocks ?? []) map.set(b.start, b.categoryId)
    return map
  }, [dayBlocks])

  // Minutes still unassigned per category: the budget's per-period
  // allocation minus time already categorized to that category across every
  // day of the period this budget governs.
  const remainingByCategory = useMemo(() => {
    const rem = new Map<string, number>()
    if (!activeBudget) return rem
    const coveredDays = periodCoveredDays(budgets ?? [], activeBudget, iso)
    const spent = new Map<string, number>()
    for (const b of periodBlocks ?? []) {
      if (!coveredDays.has(isoDate(new Date(b.start)))) continue
      spent.set(b.categoryId, (spent.get(b.categoryId) ?? 0) + 30)
    }
    for (const a of allocations ?? [])
      rem.set(a.categoryId, a.minutes - (spent.get(a.categoryId) ?? 0))
    return rem
  }, [activeBudget, budgets, iso, periodBlocks, allocations])

  const pastStarts = useMemo(
    () => starts.filter((s) => isBlockPast(s, now)),
    [starts, now],
  )
  // A short peek at what's coming — shown but not categorizable.
  const futurePreview = useMemo(
    () => starts.filter((s) => !isBlockPast(s, now)).slice(0, 4),
    [starts, now],
  )
  const toProcess = pastStarts.filter((s) => !blockCategory.has(s)).length
  const categorizedCount = pastStarts.length - toProcess

  // Categorized blocks are hidden by default; the filter toggle reveals them.
  const visibleStarts = useMemo(
    () =>
      pastStarts.filter((s) => showCategorized || !blockCategory.has(s)),
    [pastStarts, showCategorized, blockCategory],
  )

  // Split the day into alternating runs (uncategorized) and gaps
  // (categorized), so a hidden categorized span shows up as a visible break.
  const segments = useMemo<Segment[]>(() => {
    const out: Segment[] = []
    for (const start of pastStarts) {
      const kind: Segment['kind'] = blockCategory.has(start) ? 'gap' : 'run'
      const last = out[out.length - 1]
      if (last && last.kind === kind) last.starts.push(start)
      else out.push({ kind, starts: [start] })
    }
    return out
  }, [pastStarts, blockCategory])

  // Plain click on a block row: open the category picker for that one block.
  // Shift-click extends the multi-select range instead.
  function handleRowClick(start: number, e: React.MouseEvent) {
    if (!isBlockPast(start, now)) return
    if (e.shiftKey) {
      handleBubbleClick(start, true)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    setPickerFor((cur) =>
      cur?.start === start
        ? null
        : {
            start,
            x: rect.left + 80,
            anchorTop: rect.top,
            anchorBottom: rect.bottom,
          },
    )
  }

  // Click on the selection bubble: toggle/extend the multi-select.
  function handleBubbleClick(start: number, shiftKey: boolean) {
    if (!isBlockPast(start, now)) return
    setPickerFor(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (shiftKey && anchor !== null) {
        const lo = Math.min(anchor, start)
        const hi = Math.max(anchor, start)
        for (const s of starts) {
          if (s >= lo && s <= hi && isBlockPast(s, now)) next.add(s)
        }
      } else if (next.has(start)) {
        next.delete(start)
      } else {
        next.add(start)
      }
      return next
    })
    if (!shiftKey) setAnchor(start)
  }

  async function applyCategory(categoryId: string) {
    const targets = [...selected].filter((s) => isBlockPast(s, now))
    if (targets.length === 0) return
    if (categoryId === '__clear__') {
      await db.blocks.bulkDelete(targets)
    } else {
      await db.blocks.bulkPut(
        targets.map((start) => ({ start, categoryId })),
      )
    }
    setSelected(new Set())
    setAnchor(null)
  }

  // Categorize a single block directly from its picker popover.
  async function categorizeBlock(start: number, categoryId: string) {
    if (categoryId === '__clear__') {
      await db.blocks.delete(start)
    } else {
      await db.blocks.put({ start, categoryId })
    }
    setPickerFor(null)
  }

  const allFuture = pastStarts.length === 0

  // Whether the viewed day is today — only then is "now" on this timeline.
  const isToday = iso === isoDate(new Date(now))
  const nowLabel = new Date(now).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })

  // "Select all" covers exactly what's visible — categorized blocks are
  // included only when the show-categorized filter is on.
  const allSelected =
    visibleStarts.length > 0 && visibleStarts.every((s) => selected.has(s))
  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(visibleStarts))
    setAnchor(null)
  }

  function renderRow(start: number) {
    const catId = blockCategory.get(start)
    const cat = catId ? catById.get(catId) : undefined
    const isSelected = selected.has(start)
    const isPicking = pickerFor?.start === start
    return (
      <li
        key={start}
        onClick={(e) => handleRowClick(start, e)}
        className={
          'relative flex cursor-pointer select-none items-center gap-3 border-b border-slate-100 px-3 py-2 text-sm transition-colors last:border-b-0 ' +
          (isSelected || isPicking
            ? 'bg-slate-900/[0.04]'
            : 'hover:bg-slate-50')
        }
      >
        <button
          type="button"
          aria-label={isSelected ? 'Deselect block' : 'Select block'}
          onClick={(e) => {
            e.stopPropagation()
            handleBubbleClick(start, e.shiftKey)
          }}
          className={
            'grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors ' +
            (isSelected
              ? 'border-slate-900 bg-slate-900'
              : 'border-slate-300 hover:border-slate-500')
          }
        >
          {isSelected && (
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
          )}
        </button>
        <span className="w-20 shrink-0 tabular-nums text-slate-500">
          {formatBlockTime(start)}
        </span>
        {cat ? (
          <span className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: cat.color }}
            />
            <span className="font-medium text-slate-800">{cat.name}</span>
          </span>
        ) : (
          <span className="italic text-slate-400">Uncategorized</span>
        )}

        {isPicking && pickerFor && (
          <CategoryPicker
            catList={catList}
            remainingByCategory={remainingByCategory}
            showClear={catId !== undefined}
            onPick={(id) => categorizeBlock(start, id)}
            fixedAnchor={{
              x: pickerFor.x,
              anchorTop: pickerFor.anchorTop,
              anchorBottom: pickerFor.anchorBottom,
            }}
            panelClassName="fixed z-30 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-xl"
            flyoutLeft={pickerFor.x > window.innerWidth / 2}
          />
        )}
      </li>
    )
  }

  /**
   * Render a span of hidden categorized blocks: one bar per consecutive
   * category, its width proportional to time spent (3h+ fills the track).
   */
  function renderGap(gapStarts: number[]) {
    // Group consecutive blocks sharing a category — each becomes its own line.
    const runs: { categoryId: string; starts: number[] }[] = []
    for (const s of gapStarts) {
      const categoryId = blockCategory.get(s)!
      const last = runs[runs.length - 1]
      if (last && last.categoryId === categoryId) last.starts.push(s)
      else runs.push({ categoryId, starts: [s] })
    }

    return (
      <div key={`gap-${gapStarts[0]}`} className="space-y-1">
        {runs.map((run) => {
          const cat = catById.get(run.categoryId)
          const minutes = run.starts.length * 30
          const from = run.starts[0]
          const to = run.starts[run.starts.length - 1] + BLOCK_MS
          // Cap the bar at 3 hours; anything longer fills the track.
          const pct = (Math.min(minutes, 180) / 180) * 100
          return (
            <div
              key={from}
              className="flex items-center gap-3 px-1"
              title={`${formatBlockTime(from)} – ${formatBlockTime(to)}`}
            >
              <span className="w-20 shrink-0 text-right text-xs tabular-nums text-slate-400">
                {formatBlockTime(from)}
              </span>
              <div className="relative h-7 flex-1 rounded-md bg-slate-100">
                <div
                  className="absolute inset-y-0 left-0 rounded-md ring-1 ring-inset ring-black/5"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: cat?.color ?? '#cbd5e1',
                  }}
                />
              </div>
              <span className="w-44 shrink-0 text-xs text-slate-500">
                <span className="font-medium text-slate-700">
                  {cat?.name ?? 'Unknown'}
                </span>{' '}
                · {formatDuration(minutes)}
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <DaySelector value={iso} onChange={setIso} />
        {!allFuture && (
          <div className="flex items-center gap-4">
            {visibleStarts.length > 0 && (
              <button
                onClick={toggleSelectAll}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
              >
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>
            )}
            {categorizedCount > 0 && (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-500">
                <input
                  type="checkbox"
                  checked={showCategorized}
                  onChange={(e) => setShowCategorized(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 accent-slate-900"
                />
                Show {categorizedCount} categorized
              </label>
            )}
            <p className="text-sm text-slate-500">
              {toProcess > 0 ? (
                <>
                  <span className="font-semibold text-slate-900">
                    {toProcess}
                  </span>{' '}
                  {toProcess === 1 ? 'block' : 'blocks'} to process
                </>
              ) : (
                <span className="font-medium text-emerald-600">
                  All caught up
                </span>
              )}
            </p>
          </div>
        )}
      </div>

      {allFuture ? (
        <div className="rounded-xl border border-dashed border-slate-300 px-6 py-16 text-center text-sm text-slate-400">
          This day is in the future — nothing to process yet.
        </div>
      ) : visibleStarts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 px-6 py-16 text-center text-sm text-slate-400">
          Every block this day is categorized.
        </div>
      ) : showCategorized ? (
        <ul className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {pastStarts.map(renderRow)}
        </ul>
      ) : (
        <div className="space-y-1.5">
          {segments.map((seg) =>
            seg.kind === 'run' ? (
              <ul
                key={`run-${seg.starts[0]}`}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white"
              >
                {seg.starts.map(renderRow)}
              </ul>
            ) : (
              renderGap(seg.starts)
            ),
          )}
        </div>
      )}

      {/* The seam between past and present. */}
      {isToday && !allFuture && toProcess > 0 && (
        <div className="mt-3 flex items-center gap-3">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent to-amber-400" />
          <span className="flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            You are here · {nowLabel}
          </span>
          <div className="h-px flex-1 bg-gradient-to-l from-transparent to-amber-400" />
        </div>
      )}

      {/* A glimpse of the blocks just ahead — not yet categorizable. */}
      {isToday && !allFuture && toProcess > 0 && futurePreview.length > 0 && (
        <ul className="mt-3 overflow-hidden rounded-xl border border-dashed border-slate-200 bg-slate-50/60">
          {futurePreview.map((start) => (
            <li
              key={start}
              className="flex select-none items-center gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0"
            >
              <span className="h-4 w-4 shrink-0 rounded-full border border-dashed border-slate-300" />
              <span className="w-20 shrink-0 tabular-nums text-slate-400">
                {formatBlockTime(start)}
              </span>
              <span className="text-slate-400">Upcoming</span>
            </li>
          ))}
        </ul>
      )}

      {selected.size > 0 && (
        <div className="sticky bottom-4 mt-4 flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-lg">
          <span className="text-sm font-medium text-slate-900">
            {selected.size} selected
          </span>
          <div onMouseDown={(e) => e.stopPropagation()}>
            <button
              onClick={(e) => {
                setPickerFor(null)
                const rect = e.currentTarget.getBoundingClientRect()
                setBulkPicker((cur) =>
                  cur
                    ? null
                    : {
                        x: rect.left,
                        anchorTop: rect.top,
                        anchorBottom: rect.bottom,
                      },
                )
              }}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Categorize as…
              <span aria-hidden className="text-slate-400">
                ▾
              </span>
            </button>
            {bulkPicker && (
              <CategoryPicker
                catList={catList}
                remainingByCategory={remainingByCategory}
                showClear
                onPick={(id) => {
                  applyCategory(id)
                  setBulkPicker(null)
                }}
                fixedAnchor={bulkPicker}
                panelClassName="fixed z-40 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-xl"
                flyoutLeft={bulkPicker.x > window.innerWidth / 2}
              />
            )}
          </div>
          <button
            onClick={() => {
              setSelected(new Set())
              setAnchor(null)
              setBulkPicker(null)
            }}
            className="ml-auto text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The shared category-picker panel: budgeted categories up front with their
 * remaining-time figures, the rest behind an "Other" hover flyout. Used both
 * for single-block clicks and the multi-select bar.
 */
function CategoryPicker({
  catList,
  remainingByCategory,
  showClear,
  onPick,
  fixedAnchor,
  panelClassName,
  flyoutLeft,
}: {
  catList: IndentedCategory[]
  remainingByCategory: Map<string, number>
  showClear: boolean
  onPick: (categoryId: string) => void
  fixedAnchor: { x: number; anchorTop: number; anchorBottom: number }
  panelClassName: string
  flyoutLeft: boolean
}) {
  const PANEL_WIDTH = 224 // w-56
  const MARGIN = 8 // keep clear of the viewport edges
  const panelRef = useRef<HTMLDivElement>(null)
  // Measured position; hidden on first paint until we know the panel's size.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // After mount, place the panel so it never spills past a viewport edge:
  // prefer dropping below the anchor, flip above when there isn't room.
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const height = el.offsetHeight
    const { x, anchorTop, anchorBottom } = fixedAnchor
    const left = Math.max(
      MARGIN,
      Math.min(x, window.innerWidth - PANEL_WIDTH - MARGIN),
    )
    const spaceBelow = window.innerHeight - anchorBottom
    let top: number
    if (height + MARGIN <= spaceBelow || spaceBelow >= anchorTop) {
      // Fits below, or below still has more room than above.
      top = Math.min(anchorBottom + 4, window.innerHeight - height - MARGIN)
    } else {
      top = Math.max(MARGIN, anchorTop - 4 - height)
    }
    setPos({ left, top })
  }, [fixedAnchor])

  // One category row, used in both the main list and the "Other" flyout.
  const catButton = (category: Category, depth: number) => {
    const rem = remainingByCategory.get(category.id)
    return (
      <button
        key={category.id}
        type="button"
        onClick={() => onPick(category.id)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100"
        style={{ paddingLeft: `${12 + depth * 14}px` }}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: category.color }}
        />
        <span className="truncate">{category.name}</span>
        {rem !== undefined && (
          <span
            className={
              'ml-auto shrink-0 pl-2 text-xs tabular-nums ' +
              (rem < 0 ? 'text-rose-500' : 'text-slate-400')
            }
          >
            {rem < 0
              ? `${formatDuration(-rem)} over`
              : `${formatDuration(rem)} left`}
          </span>
        )}
      </button>
    )
  }

  // The main list shows only budgeted categories; everything else hides
  // behind the "Other" flyout. With no budget, show every category directly.
  const allocated = catList.filter((c) =>
    remainingByCategory.has(c.category.id),
  )
  const hasBudget = allocated.length > 0
  const mainList = hasBudget ? allocated : catList

  return (
    <div
      ref={panelRef}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        left: pos?.left ?? fixedAnchor.x,
        top: pos?.top ?? fixedAnchor.anchorBottom + 4,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className={panelClassName}
    >
      <div className="max-h-72 overflow-y-auto">
        {mainList.map(({ category, depth }) => catButton(category, depth))}
      </div>

      {hasBudget && (
        <div className="group relative border-t border-slate-100">
          <div className="flex cursor-default items-center justify-between px-3 py-1.5 text-sm text-slate-500 group-hover:bg-slate-100">
            <span>Other</span>
            <span aria-hidden>›</span>
          </div>
          <div
            className={
              'absolute hidden max-h-72 w-56 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl group-hover:block ' +
              (flyoutLeft ? 'right-full -mr-px ' : 'left-full -ml-px ') +
              // Anchor the flyout's bottom to the row when the panel sits in
              // the lower half of the screen, so it grows upward, not off-screen.
              (pos && pos.top > window.innerHeight / 2 ? 'bottom-0' : 'top-0')
            }
          >
            {catList.map(({ category, depth }) => catButton(category, depth))}
          </div>
        </div>
      )}

      {showClear && (
        <button
          type="button"
          onClick={() => onPick('__clear__')}
          className="w-full border-t border-slate-100 px-3 py-1.5 text-left text-sm text-slate-500 hover:bg-slate-100"
        >
          Clear category
        </button>
      )}
    </div>
  )
}
