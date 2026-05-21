import { useCallback, useEffect, useRef, useState } from 'react'

/** Default swatch palette offered for categories. */
export const PALETTE = [
  '#6366f1', '#0ea5e9', '#14b8a6', '#10b981', '#84cc16', '#f59e0b',
  '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#78716c', '#94a3b8',
]

const RECENTS_KEY = 'time:recent-colors'
const MAX_RECENTS = 12

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

/** Push a color to the front of the persisted recents list. */
function rememberColor(color: string) {
  const hex = color.toLowerCase()
  const next = [hex, ...readRecents().filter((c) => c !== hex)].slice(0, MAX_RECENTS)
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch {
    /* ignore quota errors */
  }
}

// --- color math (HSV <-> hex) ----------------------------------------------

interface Hsv {
  h: number // 0-360
  s: number // 0-1
  v: number // 0-1
}

function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const to = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

function hexToHsv(hex: string): Hsv {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { h: 0, s: 0, v: 0 }
  const int = parseInt(m[1], 16)
  const r = ((int >> 16) & 255) / 255
  const g = ((int >> 8) & 255) / 255
  const b = (int & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  return { h, s, v: max }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

// --- draggable surface hook -------------------------------------------------

/** Wires pointer drag on an element, reporting normalized [0,1] coordinates. */
function useDrag(onMove: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null)
  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove

  const handle = useCallback((e: PointerEvent | React.PointerEvent) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    onMoveRef.current(
      clamp01((e.clientX - rect.left) / rect.width),
      clamp01((e.clientY - rect.top) / rect.height),
    )
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      handle(e)
      const move = (ev: PointerEvent) => handle(ev)
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [handle],
  )

  return { ref, onPointerDown }
}

// --- component --------------------------------------------------------------

interface ColorPickerProps {
  value: string
  onChange: (color: string) => void
}

/**
 * Category color control: a compact button that opens an HSV picker panel.
 * The chosen color only lands in "recents" once the user clicks Accept,
 * which also closes the panel.
 */
export default function ColorPicker({ value, onChange }: ColorPickerProps) {
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>(readRecents)

  return (
    <div className="flex flex-col gap-2.5">
      <Swatches
        label="Defaults"
        colors={PALETTE}
        value={value}
        onPick={onChange}
      />

      {recents.length > 0 && (
        <Swatches
          label="Recents"
          colors={recents}
          value={value}
          onPick={onChange}
        />
      )}

      {open ? (
        <PickerPanel
          value={value}
          onChange={onChange}
          onClose={() => {
            rememberColor(value)
            setRecents(readRecents())
            setOpen(false)
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 self-start rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
        >
          <span
            className="h-5 w-5 rounded-md border border-slate-200"
            style={{ backgroundColor: value }}
          />
          Color picker
        </button>
      )}
    </div>
  )
}

function PickerPanel({
  value,
  onChange,
  onClose,
}: ColorPickerProps & { onClose: () => void }) {
  // Hue is held locally so a fully-desaturated or black color still keeps
  // its place on the spectrum slider while dragging.
  const [hue, setHue] = useState(() => hexToHsv(value).h)

  // Keep the slider in sync when the color is changed from outside the panel
  // (e.g. a swatch click). Skip grays so box drags keep their slider spot.
  const current = hexToHsv(value)
  useEffect(() => {
    if (current.s > 0 && current.v > 0) setHue(current.h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const sat = current.s
  const val = current.v

  const box = useDrag((x, y) => {
    onChange(hsvToHex({ h: hue, s: x, v: 1 - y }))
  })

  const slider = useDrag((x) => {
    const h = x * 360
    setHue(h)
    onChange(hsvToHex({ h, s: sat, v: val }))
  })

  const hueColor = hsvToHex({ h: hue, s: 1, v: 1 })

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-slate-200 p-2.5">
      {/* SV box */}
      <div
        ref={box.ref}
        onPointerDown={box.onPointerDown}
        className="relative h-32 w-full cursor-crosshair rounded-lg"
        style={{
          backgroundColor: hueColor,
          backgroundImage:
            'linear-gradient(to top, #000, transparent), ' +
            'linear-gradient(to right, #fff, transparent)',
        }}
      >
        <div
          className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{
            left: `${sat * 100}%`,
            top: `${(1 - val) * 100}%`,
            backgroundColor: value,
          }}
        />
      </div>

      {/* Hue slider */}
      <div
        ref={slider.ref}
        onPointerDown={slider.onPointerDown}
        className="relative h-4 w-full cursor-pointer rounded-full"
        style={{
          backgroundImage:
            'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, ' +
            '#0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
        }}
      >
        <div
          className="pointer-events-none absolute top-1/2 h-5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ left: `${(hue / 360) * 100}%`, backgroundColor: hueColor }}
        />
      </div>

      {/* Hex readout */}
      <div className="flex items-center gap-2">
        <span
          className="h-6 w-6 shrink-0 rounded-md border border-slate-200"
          style={{ backgroundColor: value }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => {
            const v = e.target.value
            if (/^#?[0-9a-f]{6}$/i.test(v)) {
              const hex = v.startsWith('#') ? v : `#${v}`
              setHue(hexToHsv(hex).h)
              onChange(hex.toLowerCase())
            } else {
              onChange(v)
            }
          }}
          className="w-24 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 uppercase"
          aria-label="Hex color"
        />
      </div>

      <button
        type="button"
        onClick={onClose}
        className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
      >
        Accept
      </button>
    </div>
  )
}

function Swatches({
  label,
  colors,
  value,
  onPick,
}: {
  label: string
  colors: string[]
  value: string
  onPick: (color: string) => void
}) {
  return (
    <div>
      <span className="mb-1 block text-[11px] font-medium text-slate-400">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onPick(c)}
            aria-label={`Color ${c}`}
            className={
              'h-6 w-6 rounded-full transition-transform ' +
              (value.toLowerCase() === c.toLowerCase()
                ? 'ring-2 ring-slate-900 ring-offset-1'
                : 'hover:scale-110')
            }
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
    </div>
  )
}
