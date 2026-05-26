import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { disableSync, scheduleSync, setupSync, syncOnce } from '../lib/sync'

interface SyncSettingsProps {
  onClose: () => void
}

type Mode = 'menu' | 'new' | 'join'

/**
 * Modal that owns the entire sync setup + status surface. There are three
 * states: not configured (menu → new or join), configured (status + manual
 * sync), and an in-progress async action.
 */
export default function SyncSettings({ onClose }: SyncSettingsProps) {
  const meta = useLiveQuery(() => db.syncMeta.get('config'), [])
  const [mode, setMode] = useState<Mode>('menu')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<string | null>(null)

  async function runSync() {
    setBusy('Syncing…')
    setError(null)
    try {
      const { pushed, pulled } = await syncOnce()
      setLastResult(`Pushed ${pushed}, pulled ${pulled}.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function turnOff() {
    if (!confirm('Disable sync? Local data stays put. You can re-enable later with the same passphrase + syncId.')) return
    await disableSync()
    setMode('menu')
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">Sync</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {meta ? (
          <ConfiguredView
            meta={meta}
            onSync={runSync}
            onDisable={turnOff}
            busy={busy}
            error={error}
            lastResult={lastResult}
          />
        ) : mode === 'menu' ? (
          <Menu onPick={setMode} />
        ) : (
          <SetupForm
            mode={mode}
            onBack={() => setMode('menu')}
            onDone={onClose}
          />
        )}
      </div>
    </div>
  )
}

function Menu({ onPick }: { onPick: (m: Mode) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        End-to-end encrypted. The server stores opaque blobs — your passphrase never leaves this device.
      </p>
      <button
        onClick={() => onPick('new')}
        className="w-full rounded-lg border border-slate-200 px-4 py-3 text-left text-sm hover:border-slate-300 hover:bg-slate-50"
      >
        <div className="font-medium text-slate-900">Set up new sync</div>
        <div className="text-xs text-slate-500">First device. Pick a username and passphrase.</div>
      </button>
      <button
        onClick={() => onPick('join')}
        className="w-full rounded-lg border border-slate-200 px-4 py-3 text-left text-sm hover:border-slate-300 hover:bg-slate-50"
      >
        <div className="font-medium text-slate-900">Join existing sync</div>
        <div className="text-xs text-slate-500">Second device. Enter the same username and passphrase from the first.</div>
      </button>
    </div>
  )
}

function SetupForm({
  mode,
  onBack,
  onDone,
}: {
  mode: 'new' | 'join'
  onBack: () => void
  onDone: () => void
}) {
  const [username, setUsername] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<{ username: string } | null>(null)

  async function submit() {
    setError(null)
    if (!username.trim()) {
      setError('Username is required.')
      return
    }
    if (passphrase.length < 12) {
      setError('Passphrase must be at least 12 characters.')
      return
    }
    if (mode === 'new' && passphrase !== confirmPassphrase) {
      setError('Passphrases do not match.')
      return
    }
    setBusy(true)
    try {
      await setupSync({ username, passphrase })
      // Push the freshly backfilled rows and pull any history from peers.
      scheduleSync(0)
      if (mode === 'new') {
        setRecovery({ username: username.trim().toLowerCase() })
      } else {
        onDone()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (recovery) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">Remember these two.</p>
          <p className="mt-1 text-xs">
            To add another device or recover after a reinstall, enter the same
            username <em>and</em> passphrase. The server can't help if either
            is lost — it never sees them.
          </p>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500">Username</label>
          <div className="mt-1 rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs">
            {recovery.username}
          </div>
        </div>
        <button
          onClick={onDone}
          className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          I've saved it
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <Field label="Username" value={username} onChange={setUsername} />
      <Field
        label="Passphrase"
        value={passphrase}
        onChange={setPassphrase}
        type="password"
      />
      {mode === 'new' && (
        <Field
          label="Confirm passphrase"
          value={confirmPassphrase}
          onChange={setConfirmPassphrase}
          type="password"
        />
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2 pt-2">
        <button
          onClick={onBack}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          disabled={busy}
        >
          Back
        </button>
        <button
          onClick={submit}
          disabled={busy}
          className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? 'Working…' : mode === 'new' ? 'Create sync' : 'Join'}
        </button>
      </div>
    </div>
  )
}

function ConfiguredView({
  meta,
  onSync,
  onDisable,
  busy,
  error,
  lastResult,
}: {
  meta: { username: string; deviceId: string; serverUrl: string; lastSyncedAt: number | null }
  onSync: () => void
  onDisable: () => void
  busy: string | null
  error: string | null
  lastResult: string | null
}) {
  return (
    <div className="space-y-4">
      <dl className="space-y-2 text-xs">
        <Row label="Username" value={meta.username} mono />
        <Row label="Device" value={meta.deviceId} mono />
        <Row
          label="Last sync"
          value={
            meta.lastSyncedAt
              ? new Date(meta.lastSyncedAt).toLocaleString()
              : 'never'
          }
        />
      </dl>
      {lastResult && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          {lastResult}
        </p>
      )}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          onClick={onSync}
          disabled={busy != null}
          className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ?? 'Sync now'}
        </button>
        <button
          onClick={onDisable}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
        >
          Disable
        </button>
      </div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className={'truncate text-right text-slate-900 ' + (mono ? 'font-mono text-[11px]' : '')}>
        {value}
      </dd>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  mono,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  mono?: boolean
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={
          'mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none ' +
          (mono ? 'font-mono text-xs' : '')
        }
      />
    </label>
  )
}
