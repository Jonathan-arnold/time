import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import BudgetAssignment from '../components/BudgetAssignment'
import BudgetSchedule from '../components/BudgetSchedule'
import { db } from '../db'
import type { Budget, BudgetType, Category } from '../db'
import {
  indentCategories,
  moveCategory,
  subtreeIds,
  type DropIntent,
} from '../lib/categories'
import ColorPicker, { PALETTE } from '../components/ColorPicker'

/** Drag-and-drop state shared with each draggable category row. */
interface CategoryDnd {
  dragId: string | null
  dropTarget: { id: string; intent: DropIntent } | null
  onStart: (id: string) => void
  onOver: (id: string, intent: DropIntent) => void
  onDrop: () => void
  onEnd: () => void
}

/** Sentinel id for the permanent, shared category library "budget". */
const CATEGORY_LIBRARY = '__categories__'

function isScheduleValid(budget: Budget): boolean {
  if (budget.type === 'oneoff') {
    return (
      !!budget.startDate &&
      !!budget.endDate &&
      budget.endDate >= budget.startDate
    )
  }
  if (budget.recurrence === 'weekly') return budget.weekdays.length > 0
  if (budget.recurrence === 'monthly') return budget.monthDays.length > 0
  return false
}

export default function BudgetsTab() {
  const [selectedId, setSelectedId] = useState<string | null>(
    CATEGORY_LIBRARY,
  )
  const [creating, setCreating] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState(false)

  const budgets = useLiveQuery(() => db.budgets.toArray(), [])
  const sorted = useMemo(
    () => [...(budgets ?? [])].sort((a, b) => a.createdAt - b.createdAt),
    [budgets],
  )
  const isLibrary = selectedId === CATEGORY_LIBRARY
  const selected = isLibrary
    ? null
    : (sorted.find((b) => b.id === selectedId) ?? null)

  async function deleteBudget(id: string, name: string) {
    if (!confirm(`Delete "${name}"? Its allocations will be removed too.`))
      return
    await db.transaction('rw', db.budgets, db.budgetAllocations, async () => {
      await db.budgetAllocations.where('budgetId').equals(id).delete()
      await db.budgets.delete(id)
    })
    setSelectedId((prev) => (prev === id ? null : prev))
  }

  return (
    <div className="grid gap-6 md:grid-cols-[260px_1fr]">
      <aside className="space-y-2">
        <button
          onClick={() => setSelectedId(CATEGORY_LIBRARY)}
          className={
            'flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors ' +
            (isLibrary
              ? 'border-slate-900 bg-white'
              : 'border-slate-200 bg-slate-50 hover:bg-slate-100')
          }
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 shrink-0 text-slate-500"
          >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span className="text-sm font-medium text-slate-900">
            Categories
          </span>
          <span className="ml-auto shrink-0 rounded-md bg-slate-200 px-1.5 py-0.5 text-xs font-medium text-slate-600">
            Shared
          </span>
        </button>

        <div className="h-px bg-slate-200" />

        {sorted.map((budget) => (
          <div
            key={budget.id}
            className={
              'group flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 transition-colors ' +
              (budget.id === selectedId
                ? 'border-slate-900 bg-white'
                : 'border-slate-200 bg-white hover:bg-slate-50')
            }
          >
            <button
              onClick={() => {
                setSelectedId(budget.id)
                setEditingSchedule(!budget.scheduleAccepted)
              }}
              className="min-w-0 flex-1 truncate text-left text-sm font-medium text-slate-900"
            >
              {budget.name}
            </button>
            <span
              className={
                'shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium ' +
                (budget.type === 'recurring'
                  ? 'bg-sky-100 text-sky-700'
                  : 'bg-amber-100 text-amber-700')
              }
            >
              {budget.type === 'recurring' ? 'Recurring' : 'One-off'}
            </span>
            <button
              onClick={() => deleteBudget(budget.id, budget.name)}
              aria-label={`Delete ${budget.name}`}
              className="shrink-0 rounded-md p-1 text-slate-300 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-3.5 w-3.5"
              >
                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
              </svg>
            </button>
          </div>
        ))}

        {creating ? (
          <NewBudgetForm
            onCancel={() => setCreating(false)}
            onCreate={(id) => {
              setCreating(false)
              setSelectedId(id)
              setEditingSchedule(true)
            }}
          />
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="w-full rounded-xl border border-dashed border-slate-300 px-3 py-2.5 text-sm font-medium text-slate-500 transition-colors hover:border-slate-400 hover:text-slate-900"
          >
            + New budget
          </button>
        )}
      </aside>

      <section>
        {isLibrary ? (
          <CategoryLibrary />
        ) : selected ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            {editingSchedule ? (
              <>
                <h2 className="text-lg font-semibold text-slate-900">
                  {selected.name}
                </h2>
                <div className="mt-6">
                  <BudgetSchedule budget={selected} />
                </div>
                <div className="mt-8 border-t border-slate-100 pt-4">
                  <button
                    disabled={!isScheduleValid(selected)}
                    onClick={() => {
                      void db.budgets.update(selected.id, {
                        scheduleAccepted: true,
                      })
                      setEditingSchedule(false)
                    }}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Accept schedule
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-4">
                  <h2 className="text-lg font-semibold text-slate-900">
                    {selected.name}
                  </h2>
                  <button
                    onClick={() => setEditingSchedule(true)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
                  >
                    Edit schedule
                  </button>
                </div>
                <BudgetAssignment budget={selected} />
              </>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 px-6 py-16 text-center text-sm text-slate-400">
            {sorted.length === 0
              ? 'No budgets yet — create one to get started.'
              : 'Select a budget to view it.'}
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * The shared category library — categories defined here are inherited by
 * every budget. It cannot be scheduled or allocated.
 */
function CategoryLibrary() {
  const [creating, setCreating] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<
    { id: string; intent: DropIntent } | null
  >(null)
  const categories = useLiveQuery(() => db.categories.toArray(), [])
  const list = useMemo(
    () => indentCategories(categories ?? []),
    [categories],
  )

  const dnd: CategoryDnd = {
    dragId,
    dropTarget,
    onStart: setDragId,
    onOver: (id, intent) =>
      setDropTarget((prev) =>
        prev?.id === id && prev.intent === intent ? prev : { id, intent },
      ),
    onDrop: async () => {
      if (dragId && dropTarget) {
        const next = moveCategory(
          categories ?? [],
          dragId,
          dropTarget.id,
          dropTarget.intent,
        )
        if (next) await db.categories.bulkPut(next)
      }
      setDragId(null)
      setDropTarget(null)
    },
    onEnd: () => {
      setDragId(null)
      setDropTarget(null)
    },
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-slate-900">Categories</h2>
      <p className="mt-1 text-sm text-slate-400">
        Shared across every budget. Define your categories once here.
      </p>

      <ul className="mt-6 divide-y divide-slate-100 border-y border-slate-100">
        {list.map(({ category, depth }) => (
          <CategoryRow
            key={category.id}
            category={category}
            depth={depth}
            categories={categories ?? []}
            dnd={dnd}
          />
        ))}
      </ul>

      <div className="mt-4">
        {creating ? (
          <NewCategoryForm
            categories={categories ?? []}
            onDone={() => setCreating(false)}
          />
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:border-slate-400 hover:text-slate-900"
          >
            + New category
          </button>
        )}
      </div>
    </div>
  )
}

interface CategoryRowProps {
  category: Category
  depth: number
  categories: Category[]
  dnd: CategoryDnd
}

/** A single category in the library — display row with edit/delete, or an
 * inline edit form when being edited. */
function CategoryRow({ category, depth, categories, dnd }: CategoryRowProps) {
  const [editing, setEditing] = useState(false)
  const [addingSub, setAddingSub] = useState(false)
  const [name, setName] = useState(category.name)
  const [color, setColor] = useState(category.color)
  const [parentId, setParentId] = useState(category.parentId ?? '')

  // A category cannot be nested under itself or its own descendants.
  const excluded = useMemo(
    () => subtreeIds(categories, category.id),
    [categories, category.id],
  )
  const parentOptions = useMemo(
    () =>
      indentCategories(categories).filter(
        (o) => !excluded.has(o.category.id),
      ),
    [categories, excluded],
  )

  function startEditing() {
    setName(category.name)
    setColor(category.color)
    setParentId(category.parentId ?? '')
    setEditing(true)
  }

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) return
    await db.categories.update(category.id, {
      name: trimmed,
      color,
      parentId: parentId || null,
    })
    setEditing(false)
  }

  async function remove() {
    const ids = subtreeIds(categories, category.id)
    const extra = ids.size - 1
    const message =
      extra > 0
        ? `Delete "${category.name}" and its ${extra} subcategor${
            extra === 1 ? 'y' : 'ies'
          }?`
        : `Delete "${category.name}"?`
    if (!confirm(message)) return
    await db.categories.bulkDelete([...ids])
  }

  if (editing) {
    return (
      <li className="py-2" style={{ paddingLeft: depth * 20 }}>
        <div className="max-w-sm space-y-3 rounded-xl border border-slate-300 bg-white p-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') setEditing(false)
            }}
            placeholder="Category name"
            className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-slate-400"
          />

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Nest under
            </span>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-slate-400"
            >
              <option value="">— Top level —</option>
              {parentOptions.map(({ category: c, depth: d }) => (
                <option key={c.id} value={c.id}>
                  {'  '.repeat(d) + c.name}
                </option>
              ))}
            </select>
          </label>

          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Color
            </span>
            <ColorPicker value={color} onChange={setColor} />
          </div>

          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={!name.trim()}
              className="flex-1 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-40"
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
            >
              Cancel
            </button>
          </div>
        </div>
      </li>
    )
  }

  const isDragging = dnd.dragId === category.id
  const intent =
    dnd.dropTarget?.id === category.id && !isDragging
      ? dnd.dropTarget.intent
      : null

  return (
    <>
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        dnd.onStart(category.id)
      }}
      onDragEnd={dnd.onEnd}
      onDragOver={(e) => {
        if (!dnd.dragId || dnd.dragId === category.id) return
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        const ratio = (e.clientY - rect.top) / rect.height
        dnd.onOver(
          category.id,
          ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'child',
        )
      }}
      onDrop={(e) => {
        e.preventDefault()
        dnd.onDrop()
      }}
      className={
        'group relative flex select-none items-center gap-2 py-2 text-sm transition-colors ' +
        (isDragging ? 'opacity-40 ' : '') +
        (intent === 'child'
          ? 'rounded-md bg-slate-100 ring-1 ring-inset ring-slate-400'
          : '')
      }
      style={{ paddingLeft: depth * 20 }}
    >
      {intent === 'before' && (
        <div className="absolute inset-x-0 top-0 z-10 h-0.5 bg-slate-900" />
      )}
      {intent === 'after' && (
        <div className="absolute inset-x-0 bottom-0 z-10 h-0.5 bg-slate-900" />
      )}
      <svg
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 cursor-grab text-slate-300 transition-colors group-hover:text-slate-400"
      >
        <circle cx="5.5" cy="4" r="1.4" />
        <circle cx="10.5" cy="4" r="1.4" />
        <circle cx="5.5" cy="8" r="1.4" />
        <circle cx="10.5" cy="8" r="1.4" />
        <circle cx="5.5" cy="12" r="1.4" />
        <circle cx="10.5" cy="12" r="1.4" />
      </svg>
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: category.color }}
      />
      <span className="font-medium text-slate-800">{category.name}</span>
      <div className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={() => setAddingSub(true)}
          className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
        >
          + Sub
        </button>
        <button
          onClick={startEditing}
          className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
        >
          Edit
        </button>
        <button
          onClick={remove}
          className="rounded-md px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-50"
        >
          Delete
        </button>
      </div>
    </li>
    {addingSub && (
      <li className="py-2" style={{ paddingLeft: (depth + 1) * 20 }}>
        <NewCategoryForm
          categories={categories}
          fixedParentId={category.id}
          onDone={() => setAddingSub(false)}
        />
      </li>
    )}
    </>
  )
}

interface NewCategoryFormProps {
  categories: Category[]
  onDone: () => void
  /** When set, the new category is fixed under this parent (no parent picker). */
  fixedParentId?: string
}

/** Inline form for creating a category: name, optional parent, and color. */
function NewCategoryForm({
  categories,
  onDone,
  fixedParentId,
}: NewCategoryFormProps) {
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState(fixedParentId ?? '')
  const [color, setColor] = useState(PALETTE[0])
  const inputRef = useRef<HTMLInputElement>(null)
  const parentOptions = useMemo(
    () => indentCategories(categories),
    [categories],
  )

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed) return
    const parent = parentId || null
    const siblings = categories.filter((c) => c.parentId === parent)
    const order = siblings.reduce((max, c) => Math.max(max, c.order + 1), 0)
    await db.categories.add({
      id: crypto.randomUUID(),
      name: trimmed,
      parentId: parent,
      color,
      order,
    })
    setName('')
    setColor(PALETTE[0])
    inputRef.current?.focus()
  }

  return (
    <div className="max-w-sm space-y-3 rounded-xl border border-slate-300 bg-white p-3">
      <input
        ref={inputRef}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onDone()
        }}
        placeholder={fixedParentId ? 'Subcategory name' : 'Category name'}
        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-slate-400"
      />

      {fixedParentId === undefined && (
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500">
          Nest under
        </span>
        <select
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-slate-400"
        >
          <option value="">— Top level —</option>
          {parentOptions.map(({ category, depth }) => (
            <option key={category.id} value={category.id}>
              {'  '.repeat(depth) + category.name}
            </option>
          ))}
        </select>
      </label>
      )}

      <div>
        <span className="mb-1 block text-xs font-medium text-slate-500">
          Color
        </span>
        <ColorPicker value={color} onChange={setColor} />
      </div>

      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={!name.trim()}
          className="flex-1 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-40"
        >
          Create
        </button>
        <button
          onClick={onDone}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

interface NewBudgetFormProps {
  onCreate: (id: string) => void
  onCancel: () => void
}

/** Inline form for creating a budget — name and type only, for now. */
function NewBudgetForm({ onCreate, onCancel }: NewBudgetFormProps) {
  const [name, setName] = useState('')
  const [type, setType] = useState<BudgetType>('recurring')

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed) return
    const id = crypto.randomUUID()
    await db.budgets.add({
      id,
      name: trimmed,
      type,
      recurrence: type === 'recurring' ? 'weekly' : null,
      weekdays: [],
      monthDays: [],
      coverStart: 0,
      coverEnd: 24 * 60,
      scheduleAccepted: false,
      allocationMode: 'period',
      startDate: null,
      endDate: null,
      priority: 0,
      createdAt: Date.now(),
    })
    onCreate(id)
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-300 bg-white p-3">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Budget name"
        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-slate-400"
      />

      <div className="flex gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
        {(['recurring', 'oneoff'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={
              'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ' +
              (type === t
                ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                : 'text-slate-500 hover:text-slate-900')
            }
          >
            {t === 'recurring' ? 'Recurring' : 'One-off'}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={!name.trim()}
          className="flex-1 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-40"
        >
          Create
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
