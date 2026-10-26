// Small shared pieces: the API, a polling hook, a tiny router, formatting, icons.
import { useState, useEffect, useCallback, useRef } from 'react'

export const BRAND = 'garlic'

/* ---------------- api ---------------- */

export async function api(path, body) {
  const res = await fetch(`/api${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(j.error || `request failed (${res.status})`), { status: res.status, data: j })
  return j
}

/** Fetch `path` now and every `ms`; keeps the last good value through errors. */
export function usePoll(path, ms = 8000) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const live = useRef(true)
  const load = useCallback(async () => {
    if (!path) return
    try { const d = await api(path); if (live.current) { setData(d); setError(null) } } catch (e) { if (live.current) setError(e) }
  }, [path])
  useEffect(() => {
    live.current = true
    load()
    const t = setInterval(load, ms)
    const vis = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', vis)
    return () => { live.current = false; clearInterval(t); document.removeEventListener('visibilitychange', vis) }
  }, [load, ms])
  return { data, error, reload: load }
}

/* ---------------- router ---------------- */

const subs = new Set()
export function go(to) {
  if (to === location.pathname + location.search) return
  history.pushState(null, '', to)
  window.scrollTo(0, 0)
  for (const s of subs) s()
}
export function useRoute() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const on = () => setPath(location.pathname)
    subs.add(on)
    window.addEventListener('popstate', on)
    return () => { subs.delete(on); window.removeEventListener('popstate', on) }
  }, [])
  return path
}
export function Link({ to, className, children, ...rest }) {
  return (
    <a href={to} className={className} {...rest}
      onClick={e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault(); go(to)
      }}>{children}</a>
  )
}

/* ---------------- formatting ---------------- */

export function usd(n) {
  if (n == null || !isFinite(n)) return 'n/a'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}
export function solFmt(n, d = 3) {
  if (n == null || !isFinite(n)) return '0'
  if (n === 0) return '0'
  if (n < 0.001) return n.toFixed(5)
  return n.toFixed(d)
}
export function tokens(n) {
  if (!n) return '0'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return n.toFixed(0)
}
export function pct(x, d = 1) {
  if (x == null || !isFinite(x)) return '0%'
  const v = x * 100
  if (v > 0 && v < 0.01) return '<0.01%'
  return `${v.toFixed(v < 1 ? 2 : d)}%`
}
export function ago(t) {
  if (!t) return ''
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
export const short = a => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '')
export const solscanTx = sig => `https://solscan.io/tx/${sig}`
export const solscanAcct = a => `https://solscan.io/account/${a}`
export const pumpUrl = mint => `https://pump.fun/coin/${mint}`
export const axiomUrl = mint => `https://axiom.trade/t/${mint}`
export const dexUrl = mint => `https://dexscreener.com/solana/${mint}`

/** Re-render every `ms` (for countdowns and "3m ago"). */
export function useTick(ms = 1000) {
  const [, set] = useState(0)
  useEffect(() => { const t = setInterval(() => set(x => x + 1), ms); return () => clearInterval(t) }, [ms])
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

/* ---------------- pieces ---------------- */

export function Pic({ coin, lg }) {
  const [bad, setBad] = useState(false)
  if (!coin?.image || bad) return <div className={`pic blank${lg ? ' lg' : ''}`}>{(coin?.symbol || '?').slice(0, 3)}</div>
  return <img className={`pic${lg ? ' lg' : ''}`} src={coin.image} alt="" loading="lazy" onError={() => setBad(true)} />
}

const I = (d, extra) => (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>{d}{extra}</svg>
)
export const Icon = {
  board: I(<><rect x="3.5" y="4" width="17" height="16" rx="3" /><path d="M3.5 9.5h17M9 9.5V20" /></>),
  plus: I(<path d="M12 5v14M5 12h14" />),
  flame: I(<path d="M12 21c4 0 6.5-2.6 6.5-6.2 0-3.4-2.3-5.6-3.6-7.7-.4 1.7-1.3 2.9-2.4 3.4.2-2.7-.9-5.3-3.2-7 .1 3-1.6 4.7-2.9 6.3-1 1.3-1.9 2.8-1.9 5C4.5 18.4 7.8 21 12 21Z" />),
  book: I(<><path d="M5 4.5h9.5A2.5 2.5 0 0 1 17 7v12.5H7.5A2.5 2.5 0 0 1 5 17V4.5Z" /><path d="M5 17a2.5 2.5 0 0 1 2.5-2.5H17" /></>),
  search: I(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>),
  chev: I(<path d="m9 6 6 6-6 6" />),
  back: I(<path d="m15 6-6 6 6 6" />),
  copy: I(<><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" /></>),
  out: I(<><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></>),
  x: I(<path d="M4.5 4.5 19.5 19.5M19.5 4.5l-15 15" />),
}
