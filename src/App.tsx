import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, ensureSeeded } from './db'
import TransactionsTab from './tabs/TransactionsTab'
import BudgetsTab from './tabs/BudgetsTab'
import MetricsTab from './tabs/MetricsTab'
import SyncSettings from './components/SyncSettings'
import EraSwitcher from './components/EraSwitcher'
import { currentEra } from './lib/eras'
import { installAutoSync } from './lib/sync'

const TABS = [
  { id: 'transactions', label: 'Past', sub: 'Categorize' },
  { id: 'metrics', label: 'Present', sub: 'Metrics' },
  { id: 'budgets', label: 'Future', sub: 'Budgets' },
] as const

type TabId = (typeof TABS)[number]['id']

export default function App() {
  const [active, setActive] = useState<TabId>('transactions')
  const [syncOpen, setSyncOpen] = useState(false)

  // The era being viewed in the Budgets and Metrics tabs. Null means "the
  // current era", so the view follows along when a new era begins.
  const eras = useLiveQuery(() => db.eras.toArray(), [])
  const [viewingEraId, setViewingEraId] = useState<string | null>(null)
  const viewingEra = useMemo(() => {
    const list = eras ?? []
    return list.find((e) => e.id === viewingEraId) ?? currentEra(list)
  }, [eras, viewingEraId])
  const viewingPast = viewingEra?.endDate != null

  // A brief calibration flourish on first load.
  const [calibrating, setCalibrating] = useState(true)
  useEffect(() => {
    const id = setTimeout(() => setCalibrating(false), 1800)
    return () => clearTimeout(id)
  }, [])

  // Populate default categories on first run.
  useEffect(() => {
    void ensureSeeded()
  }, [])

  // Auto-sync: debounced push on every local change, plus pull on focus/timer.
  // No-op until the user configures sync via the gear modal.
  useEffect(() => {
    installAutoSync()
  }, [])

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-900 text-white">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
              >
                {/* A clock dial with hour and minute hands. */}
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3.5 2" />
              </svg>
            </span>
            <h1 className="text-base font-semibold tracking-tight">
              Time
            </h1>
          </div>

          <div className="order-3 flex w-full items-center gap-2 sm:order-none sm:w-auto">
          <nav className="flex flex-1 gap-0.5 rounded-xl border border-slate-200 bg-slate-50 p-1 sm:flex-none">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActive(tab.id)}
                className={
                  'flex-1 rounded-lg px-3 py-3 text-base font-medium transition-colors sm:flex-none sm:px-3.5 sm:py-1.5 sm:text-sm ' +
                  (active === tab.id
                    ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                    : 'text-slate-500 hover:text-slate-900')
                }
              >
                {tab.label}
                <span className="hidden font-normal text-slate-400 sm:inline">
                  {' '}— {tab.sub}
                </span>
              </button>
            ))}
          </nav>
            <EraSwitcher
              eras={eras ?? []}
              viewing={viewingEra}
              onSelect={setViewingEraId}
            />
            <button
              onClick={() => setSyncOpen(true)}
              className="rounded-lg border border-slate-200 bg-white p-3 text-slate-500 transition-colors hover:text-slate-900 sm:p-2"
              aria-label="Sync settings"
              title="Sync"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5 sm:h-4 sm:w-4"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>
      </header>
      {syncOpen && <SyncSettings onClose={() => setSyncOpen(false)} />}

      <main className="mx-auto max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
        {/* Reviewing a past era scopes Budgets and Metrics to it. */}
        {viewingPast && active !== 'transactions' && viewingEra && (
          <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span>
              Viewing <span className="font-semibold">{viewingEra.name}</span>,
              a past era.
            </span>
            <button
              onClick={() => setViewingEraId(null)}
              className="ml-auto rounded-lg border border-amber-300 bg-white px-3 py-1 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-100"
            >
              Back to now
            </button>
          </div>
        )}
        {active === 'transactions' ? (
          <TransactionsTab />
        ) : !viewingEra ? (
          <div className="text-slate-400">Loading…</div>
        ) : active === 'metrics' ? (
          <MetricsTab key={viewingEra.id} era={viewingEra} />
        ) : (
          <BudgetsTab key={viewingEra.id} era={viewingEra} />
        )}
      </main>

      {/* First-load flourish. */}
      <div
        className={
          'pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2 transition-all duration-500 ' +
          (calibrating
            ? 'translate-y-0 opacity-100'
            : 'translate-y-3 opacity-0')
        }
      >
        <div className="flex items-center gap-2.5 rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-lg">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="h-3.5 w-3.5 animate-spin"
          >
            <path d="M21 12a9 9 0 1 1-6.2-8.6" />
          </svg>
          Recalibrating timeline…
        </div>
      </div>
    </div>
  )
}
