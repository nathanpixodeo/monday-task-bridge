import { useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Config } from './helpers/storage'
import { getConfig } from './helpers/storage'
import './style.css'

const BRIDGE_HOST = '127.0.0.1:3457'
const BRIDGE_COMMAND = 'npm run bridge'
const AUTHOR = 'Nhat Nguyen'
const DEVELOPER = 'Nexkit'
const CONTACT_EMAIL = 'nathanpixodeo@gmail.com'
// The bridge issues pairing codes with a two-minute TTL
const PAIRING_SECONDS = 120
const RING_RADIUS = 72
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

const FOCUS_RING = 'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/40'
const CARD = 'rounded-2xl border'
const SURFACE = 'border-white/[0.08] bg-white/[0.04]'
const LABEL = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400'

type Mode = 'unpaired' | 'pairing' | 'off' | 'connecting' | 'offline' | 'connected'
type Look = 'brand' | 'off' | 'connecting' | 'offline' | 'connected'
type View = 'main' | 'settings'
type BridgeHealth = 'checking' | 'up' | 'down'
type UnpairNotice = 'revoked' | 'local'
type Tone = 'danger' | 'success' | 'neutral'
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerOutline'
type ButtonSize = 'lg' | 'md' | 'sm'

const LOOKS: Look[] = ['brand', 'off', 'connecting', 'offline', 'connected']

const lookOf: Record<Mode, Look> = {
  unpaired: 'brand',
  pairing: 'brand',
  off: 'off',
  connecting: 'connecting',
  offline: 'offline',
  connected: 'connected'
}

const discGradient: Record<Look, string> = {
  brand: 'from-violet-500 to-indigo-600',
  off: 'from-slate-700 to-slate-800',
  connecting: 'from-amber-400 to-amber-600',
  offline: 'from-rose-500 to-rose-700',
  connected: 'from-emerald-400 to-emerald-600'
}

const discGlow: Record<Look, string> = {
  brand: 'shadow-[0_12px_40px_-10px_rgba(99,102,241,0.75)]',
  off: 'shadow-[0_12px_32px_-12px_rgba(0,0,0,0.9)] ring-1 ring-white/10',
  connecting: 'shadow-[0_12px_40px_-10px_rgba(245,158,11,0.7)]',
  offline: 'shadow-[0_12px_40px_-10px_rgba(244,63,94,0.7)]',
  connected: 'shadow-[0_12px_40px_-10px_rgba(16,185,129,0.75)]'
}

const haloTint: Record<Look, string> = {
  brand: 'bg-violet-500/35',
  off: 'bg-slate-500/35 opacity-0',
  connecting: 'bg-amber-500/35',
  offline: 'bg-rose-500/35',
  connected: 'bg-emerald-500/35'
}

const rippleBorder: Record<Look, string> = {
  brand: 'border-violet-400',
  off: 'border-slate-400',
  connecting: 'border-amber-400',
  offline: 'border-rose-400',
  connected: 'border-emerald-400'
}

// A local bridge answers in milliseconds; without a hold the amber sweep would never be seen
const MIN_CONNECTING_MS = 900

const toneStyles: Record<Tone, { box: string; icon: string }> = {
  danger: { box: 'border-rose-500/25 bg-rose-500/10 text-rose-50', icon: 'text-rose-400' },
  success: { box: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-50', icon: 'text-emerald-400' },
  neutral: { box: 'border-white/[0.08] bg-white/[0.05] text-slate-200', icon: 'text-slate-400' }
}

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'bg-linear-to-r from-violet-500 to-indigo-500 text-white shadow-lg shadow-indigo-500/25 enabled:hover:brightness-110',
  secondary: 'border border-white/[0.08] bg-white/[0.06] text-slate-100 enabled:hover:bg-white/[0.1]',
  danger: 'bg-rose-600 text-white shadow-lg shadow-rose-600/20 enabled:hover:bg-rose-500',
  dangerOutline: 'border border-rose-500/40 text-rose-300 enabled:hover:bg-rose-500/10 enabled:hover:text-rose-200'
}

const buttonSizes: Record<ButtonSize, string> = {
  lg: 'h-11 rounded-xl px-4 text-sm',
  md: 'h-9 rounded-xl px-3.5 text-sm',
  sm: 'h-8 rounded-lg px-3 text-xs'
}

function send<T>(message: Record<string, unknown>): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: T | undefined) => {
      void chrome.runtime.lastError // a missing reply resolves undefined instead of logging
      resolve(response)
    })
  })
}

function getMode(config: Config): Mode {
  if (!config.paired) return config.status === 'pairing' && config.pairCode ? 'pairing' : 'unpaired'
  if (!config.enabled) return 'off'
  if (config.status === 'authenticated') return 'connected'
  if (config.status === 'connecting' || config.status === 'connected') return 'connecting'
  return 'offline'
}

function secondsUntil(iso: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000))
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`
}

function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  return [hours, minutes, totalSeconds % 60].map((part) => String(part).padStart(2, '0')).join(':')
}

function formatAgo(then: Date, now: number): string {
  const minutes = Math.floor((now - then.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`
  return then.toLocaleDateString()
}

// ─── Hooks ───────────────────────────────────────────────────────────

function useConfig(): Config | null {
  const [config, setConfigState] = useState<Config | null>(null)

  useEffect(() => {
    getConfig().then(setConfigState)

    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.config?.newValue) {
        setConfigState(changes.config.newValue as Config)
      }
    }
    chrome.storage.local.onChanged.addListener(listener)

    return () => {
      chrome.storage.local.onChanged.removeListener(listener)
    }
  }, [])

  return config
}

function useBridgeHealth(enabled: boolean): BridgeHealth {
  const [health, setHealth] = useState<BridgeHealth>('checking')

  useEffect(() => {
    if (!enabled) return
    setHealth('checking')
    let cancelled = false

    const check = async () => {
      let next: BridgeHealth = 'down'
      try {
        const res = await fetch(`http://${BRIDGE_HOST}/health`, { signal: AbortSignal.timeout(1500) })
        const body: { status?: string } = await res.json()
        if (body.status === 'ok') next = 'up'
      } catch {
        // an unreachable bridge is the expected "not started yet" answer, not a failure to surface
      }
      if (!cancelled) setHealth(next)
    }

    void check()
    const timer = setInterval(check, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [enabled])

  return health
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}

/** The mode to draw: holds 'connecting' for MIN_CONNECTING_MS so a fast connect still shows its sweep. */
function useDisplayMode(mode: Mode | null): Mode | null {
  const [shown, setShown] = useState<Mode | null>(mode)
  const connectingSince = useRef<number | null>(null)

  useEffect(() => {
    if (mode === null) return
    if (mode === 'connecting') {
      connectingSince.current ??= Date.now()
      setShown(mode)
      return
    }
    const since = connectingSince.current
    connectingSince.current = null
    const wait = since === null ? 0 : MIN_CONNECTING_MS - (Date.now() - since)
    if (wait <= 0) {
      setShown(mode)
      return
    }
    const timer = setTimeout(() => setShown(mode), wait)
    return () => clearTimeout(timer)
  }, [mode])

  // Before the effect first runs (config just loaded) draw the real mode, never a stale one
  return shown ?? mode
}

// ─── Icons ───────────────────────────────────────────────────────────

function Icon({
  className = 'size-4',
  strokeWidth = 2,
  children
}: {
  className?: string
  strokeWidth?: number
  children: ReactNode
}) {
  return (
    <svg
      className={`shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function PowerGlyph({ className, strokeWidth = 2.4 }: { className?: string; strokeWidth?: number }) {
  return (
    <Icon className={className} strokeWidth={strokeWidth}>
      <path d="M12 3v9" />
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
    </Icon>
  )
}

function GearIcon() {
  return (
    <Icon className="size-[18px]" strokeWidth={1.8}>
      <path d="M10.08 4.85 10.44 2.12h3.12l.36 2.73 1.78.74 2.18-1.68 2.21 2.21-1.68 2.18.74 1.78 2.73.36v3.12l-2.73.36-.74 1.78 1.68 2.18-2.21 2.21-2.18-1.68-1.78.74-.36 2.73h-3.12l-.36-2.73-1.78-.74-2.18 1.68-2.21-2.21 1.68-2.18-.74-1.78-2.73-.36v-3.12l2.73-.36.74-1.78-1.68-2.18 2.21-2.21 2.18 1.68Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  )
}

function BackIcon() {
  return (
    <Icon className="size-[18px]">
      <path d="M19 12H5" />
      <path d="m11 18-6-6 6-6" />
    </Icon>
  )
}

function ServerIcon() {
  return (
    <Icon>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </Icon>
  )
}

function RetryIcon() {
  return (
    <Icon>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6l-2.5 2.5" />
      <path d="M3.5 3.5v5h5" />
    </Icon>
  )
}

function DocIcon() {
  return (
    <Icon>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </Icon>
  )
}

function InfoIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4.5M12 8h.01" />
    </Icon>
  )
}
function ImageIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m21 16-5-5-9 9" />
    </Icon>
  )
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5M12 16h.01" />
    </Icon>
  )
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </Icon>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  )
}

function CopyIcon() {
  return (
    <Icon>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </Icon>
  )
}

function XIcon() {
  return (
    <Icon>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  )
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  )
}

function Spinner({ className = 'size-4' }: { className?: string }) {
  return (
    <svg
      className={`shrink-0 animate-spin motion-reduce:animate-none ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

// ─── Primitives ──────────────────────────────────────────────────────

function BrandMark() {
  // The extension's own toolbar icon, so the popup and the toolbar match
  return <img src="icons/icon-48.png" alt="" aria-hidden="true" className="size-[26px] shrink-0 object-contain" />
}

function IconButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`grid size-9 cursor-pointer place-items-center rounded-xl text-slate-400 transition duration-150 hover:bg-white/[0.06] hover:text-slate-100 ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'className'> {
  variant: ButtonVariant
  size: ButtonSize
  block?: boolean
  busy?: boolean
}

function Button({ variant, size, block = false, busy = false, disabled, children, ...rest }: ButtonProps) {
  // A busy button stays fully opaque so its spinner reads as progress, not as unavailable
  const state = busy
    ? 'cursor-progress'
    : disabled
      ? 'cursor-not-allowed opacity-50'
      : 'cursor-pointer active:scale-[0.98]'

  return (
    <button
      type="button"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 font-medium transition duration-150 ${buttonSizes[size]} ${buttonVariants[variant]} ${state} ${block ? 'w-full' : ''} ${FOCUS_RING}`}
      {...rest}
    >
      {children}
    </button>
  )
}

function IconTile({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-white/[0.06] text-slate-300 ring-1 ring-white/[0.04] ring-inset"
    >
      {children}
    </span>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => {} // denied clipboard access is not an error: the text stays selectable on screen
    )
  }

  const current = copied ? 'Copied' : label

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={current}
      title={current}
      className={`grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg text-slate-400 transition duration-150 hover:bg-white/[0.08] hover:text-slate-100 ${FOCUS_RING}`}
    >
      {copied ? <CheckIcon className="size-4 text-emerald-400" /> : <CopyIcon />}
    </button>
  )
}

function CommandChip({ command }: { command: string }) {
  return (
    <div className="flex h-10 items-center gap-2.5 rounded-xl border border-white/[0.06] bg-black/30 pr-1.5 pl-3">
      <span aria-hidden="true" className="font-mono text-xs text-violet-300/70">
        $
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-slate-200 select-all">{command}</code>
      <CopyButton text={command} label="Copy command" />
    </div>
  )
}

function Toast({
  tone,
  icon,
  onDismiss,
  action,
  children
}: {
  tone: Tone
  icon: ReactNode
  onDismiss?: () => void
  action?: ReactNode
  children: ReactNode
}) {
  const styles = toneStyles[tone]

  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`flex animate-fade-in gap-3 rounded-2xl border p-3 text-sm motion-reduce:animate-none ${styles.box}`}
    >
      <span className={`mt-0.5 ${styles.icon}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="leading-5 break-words">{children}</p>
        {action && <div className="mt-2.5">{action}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
          className={`-mt-1 -mr-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg opacity-60 transition duration-150 hover:bg-white/10 hover:opacity-100 ${FOCUS_RING}`}
        >
          <XIcon />
        </button>
      )}
    </div>
  )
}

function TimeAgo({ iso }: { iso: string }) {
  const now = useNow(30_000)
  const then = new Date(iso)

  return (
    <time dateTime={iso} title={then.toLocaleString()}>
      {formatAgo(then, now)}
    </time>
  )
}

// ─── Header and hero ─────────────────────────────────────────────────

function Header({
  view,
  paired,
  onNavigate
}: {
  view: View
  paired: boolean
  onNavigate: (next: View) => void
}) {
  return (
    <header className="flex h-14 items-center justify-between px-4">
      <div className="flex items-center gap-2.5">
        <BrandMark />
        {view === 'settings' ? (
          <h1 className="text-[15px] font-semibold tracking-tight">Settings</h1>
        ) : (
          <div>
            <h1 className="text-[15px] leading-4 font-semibold tracking-tight">Task Bridge</h1>
            <p className="mt-0.5 text-[11px] leading-3 text-slate-500">for monday.com</p>
          </div>
        )}
      </div>
      {view === 'settings' ? (
        <IconButton label="Back" onClick={() => onNavigate('main')}>
          <BackIcon />
        </IconButton>
      ) : (
        paired && (
          <IconButton label="Settings" onClick={() => onNavigate('settings')}>
            <GearIcon />
          </IconButton>
        )
      )}
    </header>
  )
}

function PowerButton({
  mode,
  pairingProgress,
  requesting,
  disabled,
  onToggle
}: {
  mode: Mode
  pairingProgress: number | null
  requesting: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const [ripple, setRipple] = useState<{ key: number; look: Look } | null>(null)
  const pressRef = useRef<HTMLSpanElement>(null)
  const look = lookOf[mode]
  const on = mode === 'connected' || mode === 'connecting' || mode === 'offline'
  const pulsing = mode === 'connecting' || mode === 'pairing' || requesting
  const arcFill = mode === 'connected' || mode === 'offline' ? 1 : (pairingProgress ?? 0)
  const arcStroke =
    mode === 'offline'
      ? 'stroke-rose-500'
      : mode === 'pairing'
        ? 'stroke-violet-400'
        : mode === 'connected'
          ? 'stroke-emerald-400'
          : 'stroke-slate-400'
  const arcOpacity = arcFill === 0 ? 'opacity-0' : mode === 'offline' ? 'opacity-60' : 'opacity-100'
  const spinnerStroke = mode === 'connecting' ? 'stroke-amber-400' : requesting ? 'stroke-violet-400' : null

  const press = () => {
    // The ripple takes the color of where the tap is heading, so turning on and off feel different
    setRipple({ key: Date.now(), look: mode === 'unpaired' ? 'brand' : on ? 'off' : 'connecting' })
    // Web Animations replays the squeeze in place; remounting the disc would cancel its color cross-fade
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pressRef.current?.animate(
        [
          { transform: 'scale(1)' },
          { transform: 'scale(0.88)', offset: 0.3 },
          { transform: 'scale(1.04)', offset: 0.65 },
          { transform: 'scale(1)' }
        ],
        { duration: 450, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
      )
    }
    onToggle()
  }

  return (
    <div className="relative size-[152px]">
      <div
        aria-hidden="true"
        className={`absolute -inset-4 rounded-full blur-2xl transition duration-500 motion-reduce:animate-none ${haloTint[look]} ${pulsing ? 'animate-pulse' : look === 'connected' ? 'animate-breathe' : ''}`}
      />
      {look === 'connected' && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 animate-glow-burst rounded-full bg-emerald-400/45 blur-md motion-reduce:hidden"
        />
      )}
      {ripple && (
        <span
          key={ripple.key}
          aria-hidden="true"
          onAnimationEnd={() => setRipple(null)}
          className={`pointer-events-none absolute inset-[18px] animate-power-ripple rounded-full border-2 motion-reduce:hidden ${rippleBorder[ripple.look]}`}
        />
      )}
      <svg aria-hidden="true" viewBox="0 0 152 152" fill="none" className="absolute inset-0 size-full -rotate-90">
        <circle cx="76" cy="76" r={RING_RADIUS} strokeWidth="3" className="stroke-white/10" />
        <circle
          cx="76"
          cy="76"
          r={RING_RADIUS}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={RING_LENGTH * (1 - arcFill)}
          // The ring draws in on connect and drains on disconnect; it fades only after draining
          style={{
            transition: `stroke-dashoffset 700ms cubic-bezier(0.2, 0.7, 0.2, 1), stroke 300ms ease, opacity 300ms ease ${arcFill === 0 ? '600ms' : '0ms'}`
          }}
          className={`${arcStroke} ${arcOpacity}`}
        />
      </svg>
      <svg
        aria-hidden="true"
        viewBox="0 0 152 152"
        fill="none"
        className={`absolute inset-0 size-full animate-spin-slow transition-opacity duration-300 motion-reduce:animate-none ${spinnerStroke ? 'opacity-100' : 'opacity-0'}`}
      >
        <circle
          cx="76"
          cy="76"
          r={RING_RADIUS}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${RING_LENGTH * 0.25} ${RING_LENGTH}`}
          className={spinnerStroke ?? 'stroke-transparent'}
        />
      </svg>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Bridge connection"
        aria-describedby="hero-subtitle"
        disabled={disabled}
        onClick={press}
        className={`absolute inset-[18px] rounded-full transition-[box-shadow,filter] duration-500 focus-visible:ring-4 focus-visible:ring-white/40 focus-visible:outline-hidden ${discGlow[look]} ${disabled ? 'cursor-default' : 'cursor-pointer hover:brightness-110'}`}
      >
        <span ref={pressRef} aria-hidden="true" className="absolute inset-0 grid place-items-center rounded-full">
          {/* Gradients cannot be interpolated, so each look is its own layer. The new one fades in on
              top while the old one stays opaque underneath; fading both at once dims the disc midway. */}
          {LOOKS.map((key) => (
            <span
              key={key}
              className={`absolute inset-0 rounded-full bg-linear-to-b transition-opacity ${discGradient[key]} ${key === look ? 'z-[1] opacity-100 duration-500' : 'z-0 opacity-0 delay-500 duration-0'}`}
            />
          ))}
          <span className="absolute inset-0 z-[2] rounded-full bg-linear-to-b from-white/20 via-white/0 to-black/10" />
          <PowerGlyph
            key={look}
            className={`relative z-[3] size-[46px] animate-glyph-pop transition-colors duration-300 motion-reduce:animate-none ${look === 'off' ? 'text-slate-300' : 'text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.25)]'}`}
          />
        </span>
      </button>
    </div>
  )
}

function SessionChip({ since, now }: { since: string; now: number }) {
  const elapsed = Math.max(0, Math.floor((now - Date.parse(since)) / 1000))

  return (
    <p className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 tabular-nums ring-1 ring-emerald-400/15 ring-inset">
      <span aria-hidden="true" className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75 motion-reduce:hidden" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
      </span>
      <span>
        Live · <time dateTime={`PT${elapsed}S`}>{formatElapsed(elapsed)}</time>
      </span>
    </p>
  )
}

function Hero({
  config,
  mode,
  requesting,
  disabled,
  showBridgeHint,
  onToggle
}: {
  config: Config
  mode: Mode
  requesting: boolean
  disabled: boolean
  showBridgeHint: boolean
  onToggle: () => void
}) {
  const now = useNow(1000)
  const secondsLeft = mode === 'pairing' && config.expiresAt ? secondsUntil(config.expiresAt, now) : null

  const copy: Record<Mode, { title: string; subtitle: ReactNode }> = {
    unpaired: {
      title: 'Not paired',
      subtitle: requesting ? 'Requesting a pairing code…' : 'Tap the button to pair with your local bridge'
    },
    pairing: {
      title: 'Approve pairing',
      subtitle:
        secondsLeft === 0 ? (
          <span className="text-rose-400">Code expired</span>
        ) : secondsLeft !== null ? (
          `Code expires in ${formatClock(secondsLeft)}`
        ) : (
          'Waiting for approval'
        )
    },
    off: { title: 'Disconnected', subtitle: 'Tap to connect your agents' },
    connecting: { title: 'Connecting…', subtitle: `Reaching the bridge on ${BRIDGE_HOST}` },
    offline: { title: 'Bridge offline', subtitle: `Start it with ${BRIDGE_COMMAND}` },
    connected: { title: 'Connected', subtitle: 'Agents can read your monday tasks' }
  }

  return (
    <section className="flex flex-col items-center px-4 pt-4 pb-3">
      <PowerButton
        mode={mode}
        pairingProgress={secondsLeft === null ? null : secondsLeft / PAIRING_SECONDS}
        requesting={requesting}
        disabled={disabled}
        onToggle={onToggle}
      />
      <div aria-live="polite" className="mt-5">
        <h2
          key={mode}
          className="animate-fade-in text-[22px] leading-7 font-semibold tracking-tight text-white motion-reduce:animate-none"
        >
          {copy[mode].title}
        </h2>
      </div>
      <p id="hero-subtitle" className="mt-1 text-sm leading-5 text-slate-400 tabular-nums">
        {copy[mode].subtitle}
      </p>
      {/* A fixed slot keeps the hero the same height whether or not a chip shows */}
      <div className="mt-3 flex h-7 items-center">
        {mode === 'connected' && config.connectedAt && <SessionChip since={config.connectedAt} now={now} />}
        {showBridgeHint && (
          <p
            role="status"
            className="inline-flex animate-fade-in items-center gap-1.5 rounded-full bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 ring-1 ring-rose-400/20 ring-inset motion-reduce:animate-none"
          >
            <AlertIcon className="size-3.5" />
            Start the bridge first
          </p>
        )}
      </div>
    </section>
  )
}

// ─── Content ─────────────────────────────────────────────────────────

function HealthPill({ health }: { health: BridgeHealth }) {
  if (health === 'checking') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-slate-400">
        <Spinner className="size-3" />
        Checking
      </span>
    )
  }
  const up = health === 'up'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${up ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${up ? 'bg-emerald-400' : 'bg-rose-400'}`} />
      {up ? 'Running' : 'Not running'}
    </span>
  )
}

function BridgeCard({ health, highlight }: { health: BridgeHealth; highlight: boolean }) {
  return (
    <section
      aria-labelledby="bridge-title"
      className={`${CARD} bg-white/[0.04] p-4 transition duration-300 ${highlight ? 'border-rose-400/40 ring-2 ring-rose-400/20' : 'border-white/[0.08]'}`}
    >
      <div className="flex items-center gap-3">
        <IconTile>
          <ServerIcon />
        </IconTile>
        <div className="min-w-0 flex-1">
          <h3 id="bridge-title" className="text-sm leading-5 font-medium text-slate-100">
            Local bridge
          </h3>
          <p className="font-mono text-xs leading-4 text-slate-400">{BRIDGE_HOST}</p>
        </div>
        <div aria-live="polite">
          <HealthPill health={health} />
        </div>
      </div>
      {health === 'down' && (
        <div className="mt-3 flex flex-col gap-2">
          <CommandChip command={BRIDGE_COMMAND} />
          <p className="text-xs text-slate-400">Then tap the power button to pair.</p>
        </div>
      )}
    </section>
  )
}

function PairingCard({ code, expiresAt }: { code: string; expiresAt: string | null }) {
  const now = useNow(1000)
  const expired = expiresAt !== null && secondsUntil(expiresAt, now) === 0

  return (
    <section aria-labelledby="pairing-title" className={`${CARD} ${SURFACE} p-4`}>
      <h3 id="pairing-title" className={LABEL}>
        Pairing code
      </h3>
      <div className="relative mt-2 flex items-center justify-center">
        {/* the left padding offsets the trailing letter-spacing so the digits sit centered */}
        <p className="pl-[0.35em] font-mono text-[34px] leading-[48px] font-semibold tracking-[0.35em] text-white">
          {code}
        </p>
        <div className="absolute top-1/2 right-0 -translate-y-1/2">
          <CopyButton text={code} label="Copy code" />
        </div>
      </div>
      <div className="mt-3">
        <CommandChip command={`npm run pair -- ${code}`} />
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-3">
        {expired ? (
          <p className="text-sm text-slate-400">Cancel to get a new code</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-slate-300">
            <Spinner className="size-3.5 text-violet-300" />
            Waiting for approval…
          </p>
        )}
        <button
          type="button"
          onClick={() => void send({ type: 'cancel-pairing' })}
          className={`-mr-2 cursor-pointer rounded-lg px-2 py-1 text-sm font-medium text-slate-400 transition duration-150 hover:bg-white/[0.06] hover:text-slate-100 ${FOCUS_RING}`}
        >
          Cancel
        </button>
      </div>
    </section>
  )
}

function LastCaptureRow({ config }: { config: Config }) {
  const [open, setOpen] = useState(false)

  if (!config.lastCaptureAt) {
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <IconTile>
          <DocIcon />
        </IconTile>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 font-medium text-slate-300">No captures yet</p>
          <p className="text-xs leading-4 text-slate-400">Open a monday task to capture it</p>
        </div>
      </div>
    )
  }

  const title = config.lastTaskTitle || 'Untitled task'
  const complete = config.lastCaptureComplete === true
  const warnings = config.lastWarnings
  const count = warnings.length

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <IconTile>
          <DocIcon />
        </IconTile>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm leading-5 font-medium text-slate-100" title={title}>
            <span className="sr-only">Last capture: </span>
            {title}
          </p>
          <p className="flex items-center gap-1.5 text-xs leading-4 text-slate-400">
            <TimeAgo iso={config.lastCaptureAt} />
            <span aria-hidden="true">·</span>
            <span
              aria-hidden="true"
              className={`size-1.5 rounded-full ${complete ? 'bg-emerald-400' : 'bg-amber-400'}`}
            />
            {complete ? 'Complete' : 'Incomplete'}
          </p>
        </div>
        {count > 0 && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls="capture-warnings"
            aria-label={`${open ? 'Hide' : 'Show'} ${count} warning${count === 1 ? '' : 's'}`}
            className={`-mr-1.5 inline-flex h-7 shrink-0 cursor-pointer items-center gap-0.5 rounded-lg pr-1 pl-2 text-xs font-semibold text-amber-300 tabular-nums transition duration-150 hover:bg-white/[0.06] ${FOCUS_RING}`}
          >
            {count}
            <ChevronIcon
              className={`size-4 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>
      {open && (
        <ul
          id="capture-warnings"
          className="mt-2.5 ml-11 flex animate-fade-in list-disc flex-col gap-1 pl-4 text-xs leading-4 break-words text-amber-200/80 marker:text-amber-400/60 motion-reduce:animate-none"
        >
          {warnings.map((warning, index) => (
            <li key={`${index}-${warning}`}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PermissionsCard({
  origins,
  error,
  onAllow
}: {
  origins: string[]
  error: string | null
  onAllow: () => void
}) {
  return (
    <div
      role="status"
      className="flex animate-fade-in gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.08] p-3 motion-reduce:animate-none"
    >
      <ImageIcon className="mt-0.5 size-4 text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-5 font-medium text-amber-50">Allow image hosts</p>
        <p className="mt-0.5 text-xs leading-4 text-amber-100/70">
          Some original images are on hosts this extension can't read yet. Allow only hosts you recognize.
        </p>
        <ul className="mt-2.5 flex flex-col gap-1 rounded-lg bg-black/25 px-2.5 py-2 font-mono text-[11px] leading-4 break-all text-amber-50/90">
          {origins.map((origin) => (
            <li key={origin}>{origin}</li>
          ))}
        </ul>
        <div className="mt-2.5">
          <Button variant="primary" size="sm" onClick={onAllow}>
            Allow
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-xs break-words text-rose-300">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

// ─── Settings ────────────────────────────────────────────────────────

function SettingsView({
  config,
  unpairing,
  onUnpair
}: {
  config: Config
  unpairing: boolean
  onUnpair: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const live = config.paired && config.enabled
  const reconnecting = live && (config.status === 'connecting' || config.status === 'connected')

  return (
    <main className="flex animate-fade-in flex-col gap-3 px-4 pt-1 pb-4 motion-reduce:animate-none">
      <section aria-label="Bridge" className={`${CARD} ${SURFACE} divide-y divide-white/[0.06]`}>
        <div className="flex items-center gap-3 px-4 py-3">
          <IconTile>
            <ServerIcon />
          </IconTile>
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-5 font-medium text-slate-100">Bridge address</p>
            <p className="font-mono text-xs leading-4 text-slate-400">{BRIDGE_HOST}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            busy={reconnecting}
            disabled={!live}
            onClick={() => void send({ type: 'reconnect' })}
          >
            {reconnecting && <Spinner className="size-3" />}
            Reconnect
          </Button>
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <IconTile>
            <InfoIcon />
          </IconTile>
          <p className="min-w-0 flex-1 text-sm leading-5 font-medium text-slate-100">Version</p>
          <p className="font-mono text-xs text-slate-400">v{chrome.runtime.getManifest().version}</p>
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <IconTile>
            <img src="icons/nexkit.png" alt="Nexkit" className="size-5 object-contain" />
          </IconTile>
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-5 font-medium text-slate-100">{AUTHOR}</p>
            <p className="text-xs leading-4 text-slate-400">
              Developed by {DEVELOPER} ·{' '}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                target="_blank"
                rel="noreferrer"
                className={`rounded text-slate-300 underline decoration-white/20 underline-offset-2 hover:text-white ${FOCUS_RING}`}
              >
                {CONTACT_EMAIL}
              </a>
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="unpair-title" className={`${CARD} border-rose-500/20 bg-rose-500/[0.05] p-4`}>
        <h2 id="unpair-title" className="text-sm leading-5 font-medium text-slate-100">
          Unpair this browser
        </h2>
        <p className="mt-1 text-xs leading-5 text-slate-400">
          Revokes this browser's bridge token. You'll need to pair again.
        </p>
        <div className="mt-3">
          {unpairing ? (
            <p role="status" className="flex h-9 items-center justify-center gap-2 text-sm text-rose-200">
              <Spinner />
              Unpairing…
            </p>
          ) : confirming ? (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" size="md" autoFocus onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="danger" size="md" onClick={onUnpair}>
                Unpair
              </Button>
            </div>
          ) : (
            <Button variant="dangerOutline" size="md" block onClick={() => setConfirming(true)}>
              Unpair…
            </Button>
          )}
        </div>
      </section>
    </main>
  )
}

// ─── Popup ───────────────────────────────────────────────────────────

function Popup() {
  const config = useConfig()
  const displayMode = useDisplayMode(config ? getMode(config) : null)
  // Reachability only matters before pairing; afterwards the worker's status says it
  const health = useBridgeHealth(config !== null && !config.paired)
  const [view, setView] = useState<View>('main')
  const [powerBusy, setPowerBusy] = useState(false)
  const [bridgeHint, setBridgeHint] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [unpairNotice, setUnpairNotice] = useState<UnpairNotice | null>(null)
  const [unpairing, setUnpairing] = useState(false)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [permissionsGranted, setPermissionsGranted] = useState(false)

  if (!config) return null

  // Settings only make sense while paired; an unpair from elsewhere drops back to the main view
  if (view === 'settings' && !config.paired && !unpairing) setView('main')

  const mode = displayMode ?? getMode(config)
  const error = config.error ?? localError
  const showBridgeHint = mode === 'unpaired' && bridgeHint && health === 'down'

  const startPairing = async () => {
    if (health === 'down') {
      setBridgeHint(true)
      return
    }
    setBridgeHint(false)
    setUnpairNotice(null)
    setLocalError(null)
    setPowerBusy(true)
    const response = await send<{ code?: string; error?: string }>({ type: 'start-pairing' })
    setPowerBusy(false)
    if (response?.error) setLocalError(response.error)
  }

  const togglePower = async () => {
    if (mode === 'unpaired') {
      await startPairing()
      return
    }
    setPowerBusy(true)
    await send({ type: 'set-enabled', enabled: mode === 'off' })
    setPowerBusy(false)
  }

  const allowAccess = async () => {
    setPermissionError(null)
    try {
      // chrome.permissions.request needs the click's user gesture, so nothing may be awaited before it
      const granted = await chrome.permissions.request({ origins: config.pendingOrigins })
      if (!granted) {
        setPermissionError('Permission was not granted.')
        return
      }
      await send({ type: 'permissions-granted' })
      setPermissionsGranted(true)
    } catch (e: unknown) {
      setPermissionError(e instanceof Error ? e.message : String(e))
    }
  }

  const dismissError = () => {
    setLocalError(null)
    void send({ type: 'clear-error' })
  }

  const unpair = async () => {
    setUnpairing(true)
    const response = await send<{ revoked: boolean }>({ type: 'unpair' })
    setUnpairing(false)
    setLocalError(null)
    setPermissionsGranted(false)
    setUnpairNotice(response?.revoked === true ? 'revoked' : 'local')
    setView('main')
  }

  return (
    // A shared minimum height keeps the popup window from resizing on every mode or view change
    <div className="min-h-[540px]">
      <Header view={view} paired={config.paired} onNavigate={setView} />
      {view === 'settings' ? (
        <SettingsView config={config} unpairing={unpairing} onUnpair={unpair} />
      ) : (
        <>
          <Hero
            config={config}
            mode={mode}
            requesting={powerBusy && mode === 'unpaired'}
            disabled={powerBusy || mode === 'pairing'}
            showBridgeHint={showBridgeHint}
            onToggle={togglePower}
          />
          <main className="flex flex-col gap-3 px-4 pb-4">
            {error && (
              <Toast tone="danger" icon={<AlertIcon />} onDismiss={dismissError}>
                {error}
              </Toast>
            )}
            {mode === 'unpaired' && unpairNotice === 'revoked' && (
              <Toast tone="success" icon={<CheckCircleIcon />} onDismiss={() => setUnpairNotice(null)}>
                Unpaired. The bridge token was revoked.
              </Toast>
            )}
            {mode === 'unpaired' && unpairNotice === 'local' && (
              <Toast tone="neutral" icon={<InfoIcon />} onDismiss={() => setUnpairNotice(null)}>
                Unpaired here. The bridge was offline; the next pairing replaces its token.
              </Toast>
            )}
            {config.paired && config.pendingOrigins.length > 0 && (
              <PermissionsCard origins={config.pendingOrigins} error={permissionError} onAllow={allowAccess} />
            )}
            {config.paired && permissionsGranted && (
              <Toast tone="success" icon={<CheckCircleIcon />} onDismiss={() => setPermissionsGranted(false)}>
                Access granted. The next read fetches those images.
              </Toast>
            )}

            {mode === 'unpaired' && <BridgeCard health={health} highlight={showBridgeHint} />}
            {mode === 'pairing' && config.pairCode && (
              <PairingCard code={config.pairCode} expiresAt={config.expiresAt} />
            )}

            {mode === 'offline' && (
              <>
                <CommandChip command={BRIDGE_COMMAND} />
                <Button variant="secondary" size="lg" block onClick={() => void send({ type: 'reconnect' })}>
                  <RetryIcon />
                  Retry connection
                </Button>
              </>
            )}

            {config.paired && (
              <section aria-label="Last read" className={`${CARD} ${SURFACE}`}>
                <LastCaptureRow config={config} />
              </section>
            )}
          </main>
        </>
      )}
    </div>
  )
}

// ─── Mount ───────────────────────────────────────────────────────────

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(<Popup />)
}
