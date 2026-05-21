import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { db } from '../db'
import BudgetProgress from '../components/BudgetProgress'
import { categoryMap } from '../lib/categories'
import { formatDuration } from '../lib/time'

/** One block of categorized past time is 30 minutes. */
const BLOCK_MINUTES = 30

/** View id for the all-time pie chart; budget views use the budget's id. */
const OVERVIEW = 'overview'

export default function MetricsTab() {
  const categories = useLiveQuery(() => db.categories.toArray(), [])
  const blocks = useLiveQuery(() => db.blocks.toArray(), [])
  const budgets = useLiveQuery(() => db.budgets.toArray(), [])

  /** Selected view: the overview sentinel, or a budget id. */
  const [view, setView] = useState<string>(OVERVIEW)

  const catById = useMemo(() => categoryMap(categories ?? []), [categories])

  // Roll every block up to its top-level ancestor, so the pie shows a handful
  // of meaningful slices rather than one per nested leaf.
  const rootOf = useMemo(() => {
    const cache = new Map<string, string>()
    const resolve = (id: string): string => {
      const cached = cache.get(id)
      if (cached) return cached
      let cur = catById.get(id)
      while (cur?.parentId) cur = catById.get(cur.parentId)
      const root = cur?.id ?? id
      cache.set(id, root)
      return root
    }
    return resolve
  }, [catById])

  // Total minutes per top-level category across all recorded time.
  const slices = useMemo(() => {
    const minutes = new Map<string, number>()
    for (const b of blocks ?? []) {
      const root = rootOf(b.categoryId)
      minutes.set(root, (minutes.get(root) ?? 0) + BLOCK_MINUTES)
    }
    return [...minutes.entries()]
      .map(([id, value]) => ({
        id,
        name: catById.get(id)?.name ?? 'Unknown',
        color: catById.get(id)?.color ?? '#cbd5e1',
        value,
      }))
      .sort((a, b) => b.value - a.value)
  }, [blocks, rootOf, catById])

  const total = slices.reduce((sum, s) => sum + s.value, 0)

  if (!categories || !blocks || !budgets) {
    return <div className="text-slate-400">Loading…</div>
  }

  return (
    <div>
      {/* Tab strip: the all-time Overview, then one tab per budget. */}
      <div className="mb-6 flex flex-wrap gap-1 border-b border-slate-200">
        <ViewTab
          label="Overview"
          active={view === OVERVIEW}
          onClick={() => setView(OVERVIEW)}
        />
        {budgets.map((b) => (
          <ViewTab
            key={b.id}
            label={b.name}
            active={view === b.id}
            onClick={() => setView(b.id)}
          />
        ))}
      </div>

      {view === OVERVIEW ? (
        <Overview slices={slices} total={total} />
      ) : (
        (() => {
          const budget = budgets.find((b) => b.id === view)
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

/** The all-time pie chart of time allocation across top-level categories. */
function Overview({ slices, total }: { slices: Slice[]; total: number }) {
  if (slices.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 px-6 py-16 text-center text-sm text-slate-400">
        No categorized time yet — categorize some blocks to see where it goes.
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-slate-900">
          Time allocation
        </h2>
        <p className="text-sm text-slate-500">
          {formatDuration(total)} categorized across all time.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-8">
        <div className="h-96 w-96 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={0}
                outerRadius={170}
                paddingAngle={1}
                stroke="#fff"
                strokeWidth={2}
              >
                {slices.map((s) => (
                  <Cell key={s.id} fill={s.color} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value: number) => [
                  `${formatDuration(value)} · ${Math.round(
                    (value / total) * 100,
                  )}%`,
                  '',
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <ul className="min-w-48 space-y-2">
          {slices.map((s) => (
            <li key={s.id} className="flex items-center gap-2.5 text-sm">
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              <span className="font-medium text-slate-800">{s.name}</span>
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
