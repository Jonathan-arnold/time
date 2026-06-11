import { useEffect, useMemo, useRef, useState } from 'react'
import { addDays, format } from 'date-fns'
import { db, mutate } from '../db'
import type { Era } from '../db'
import { copyCategoriesForEra, currentEra, sortEras } from '../lib/eras'
import { isoDate, parseIsoDate } from '../lib/time'

interface EraSwitcherProps {
  eras: Era[]
  /** The era being viewed (defaults to the current one). */
  viewing: Era | null
  /** Select an era to view; null returns to the current era. */
  onSelect: (id: string | null) => void
}

/** Human label for an era's span, e.g. `Mar 3 – Jun 10, 2026` or `since Mar 3`. */
function eraRangeLabel(era: Era): string {
  const start = format(parseIsoDate(era.startDate), 'MMM d, yyyy')
  if (era.endDate === null) return `since ${start}`
  return `${start} – ${format(parseIsoDate(era.endDate), 'MMM d, yyyy')}`
}

/**
 * Header dropdown for viewing and managing eras. Lists every era newest
 * first; picking one scopes the Budgets and Metrics tabs to it. The footer
 * starts a new era, which closes the current one the day before the new
 * start and optionally carries the category tree forward.
 */
export default function EraSwitcher({
  eras,
  viewing,
  onSelect,
}: EraSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const sorted = useMemo(() => sortEras(eras).reverse(), [eras])
  const current = useMemo(() => currentEra(eras), [eras])

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

  async function rename(era: Era) {
    const name = window.prompt('Rename era', era.name)?.trim()
    if (!name || name === era.name) return
    await mutate(() => db.eras.update(era.id, { name }))
  }

  if (eras.length === 0) return null

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setCreating(false)
          setOpen((o) => !o)
        }}
        className={
          'flex items-center gap-2 rounded-lg border bg-white px-3 py-3 text-sm font-medium transition-colors sm:py-2 ' +
          (open
            ? 'border-slate-400 text-slate-900'
            : 'border-slate-200 text-slate-600 hover:text-slate-900')
        }
        title="Eras"
      >
        <EraIcon />
        <span className="max-w-28 truncate">
          {viewing?.name ?? 'Eras'}
        </span>
        {viewing && viewing.endDate !== null && (
          <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-700">
            Past
          </span>
        )}
        <span aria-hidden className="text-slate-400">
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
          {creating ? (
            <NewEraForm
              current={current}
              onDone={(id) => {
                setCreating(false)
                setOpen(false)
                if (id) onSelect(null) // the new era is the current one
              }}
            />
          ) : (
            <>
              <ul className="max-h-80 overflow-y-auto">
                {sorted.map((era) => {
                  const isViewing = era.id === viewing?.id
                  const isCurrent = era.endDate === null
                  return (
                    <li key={era.id} className="group">
                      <div
                        className={
                          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ' +
                          (isViewing ? 'bg-slate-100' : 'hover:bg-slate-50')
                        }
                      >
                        <button
                          type="button"
                          onClick={() => {
                            onSelect(isCurrent ? null : era.id)
                            setOpen(false)
                          }}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-slate-900">
                              {era.name}
                            </span>
                            {isCurrent && (
                              <span className="shrink-0 rounded-md bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold text-emerald-700">
                                Now
                              </span>
                            )}
                          </span>
                          <span className="block text-xs text-slate-400">
                            {eraRangeLabel(era)}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => rename(era)}
                          aria-label={`Rename ${era.name}`}
                          className="shrink-0 rounded-md p-1 text-slate-300 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-600 group-hover:opacity-100"
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
                            <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
              <div className="mt-2 border-t border-slate-100 pt-2">
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="w-full rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:border-slate-400 hover:text-slate-900"
                >
                  + Start a new era
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Form for starting a new era. The new era begins on the chosen date; the
 * current era is closed the day before. Categories can be carried over as
 * fresh copies so editing them later never rewrites the old era.
 */
function NewEraForm({
  current,
  onDone,
}: {
  current: Era | null
  onDone: (id: string | null) => void
}) {
  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState(() => isoDate(new Date()))
  const [inherit, setInherit] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed || !startDate) return
    if (current && startDate <= current.startDate) {
      setError(
        `Must start after ${format(
          parseIsoDate(current.startDate),
          'MMM d, yyyy',
        )}, when “${current.name}” began.`,
      )
      return
    }
    const id = crypto.randomUUID()
    await mutate(async () => {
      if (current) {
        await db.eras.update(current.id, {
          endDate: isoDate(addDays(parseIsoDate(startDate), -1)),
        })
        if (inherit) {
          const categories = await db.categories
            .where('eraId')
            .equals(current.id)
            .toArray()
          await db.categories.bulkAdd(copyCategoriesForEra(categories, id))
        }
      }
      await db.eras.add({
        id,
        name: trimmed,
        startDate,
        endDate: null,
        createdAt: Date.now(),
      })
    })
    onDone(id)
  }

  return (
    <div className="space-y-3 p-2">
      <p className="text-sm font-semibold text-slate-900">Start a new era</p>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onDone(null)
        }}
        placeholder="Era name"
        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-slate-400"
      />
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500">
          Begins on
        </span>
        <input
          type="date"
          value={startDate}
          onChange={(e) => {
            setStartDate(e.target.value)
            setError(null)
          }}
          className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-slate-400"
        />
      </label>
      {current && (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={inherit}
            onChange={(e) => setInherit(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-slate-900"
          />
          Carry over categories from “{current.name}”
        </label>
      )}
      {current && (
        <p className="text-xs text-slate-400">
          “{current.name}” will end the day before. Budgets are not carried
          over — each era gets its own.
        </p>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!name.trim() || !startDate}
          className="flex-1 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-40"
        >
          Start era
        </button>
        <button
          type="button"
          onClick={() => onDone(null)}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function EraIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 text-slate-400"
    >
      {/* Layered strata — eras stacked through time. */}
      <path d="M12 2 2 7l10 5 10-5-10-5z" />
      <path d="M2 12l10 5 10-5" />
      <path d="M2 17l10 5 10-5" />
    </svg>
  )
}
