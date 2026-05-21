import { useEffect, useState } from 'react'
import { ensureSeeded } from './db'
import TransactionsTab from './tabs/TransactionsTab'
import BudgetsTab from './tabs/BudgetsTab'
import MetricsTab from './tabs/MetricsTab'

const TABS = [
  { id: 'transactions', label: 'Past', sub: 'Categorize', Component: TransactionsTab },
  { id: 'metrics', label: 'Present', sub: 'Metrics', Component: MetricsTab },
  { id: 'budgets', label: 'Future', sub: 'Budgets', Component: BudgetsTab },
] as const

type TabId = (typeof TABS)[number]['id']

export default function App() {
  const [active, setActive] = useState<TabId>('transactions')
  const ActiveComponent = TABS.find((t) => t.id === active)!.Component

  // A brief "powering up the time machine" flourish on first load.
  const [calibrating, setCalibrating] = useState(true)
  useEffect(() => {
    const id = setTimeout(() => setCalibrating(false), 1800)
    return () => clearTimeout(id)
  }, [])

  // Populate default categories on first run.
  useEffect(() => {
    void ensureSeeded()
  }, [])

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-3">
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
                {/* A speedometer-style dial with its needle mid-sweep. */}
                <path d="M3.5 15a9 9 0 0 1 17 0" />
                <path d="M12 15l5.5-4" />
                <circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <h1 className="text-base font-semibold tracking-tight">
              Time Machine
            </h1>
          </div>

          <nav className="flex gap-0.5 rounded-xl border border-slate-200 bg-slate-50 p-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActive(tab.id)}
                className={
                  'rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ' +
                  (active === tab.id
                    ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                    : 'text-slate-500 hover:text-slate-900')
                }
              >
                {tab.label}{' '}
                <span className="font-normal text-slate-400">
                  — {tab.sub}
                </span>
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <ActiveComponent />
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
