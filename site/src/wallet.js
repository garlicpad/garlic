// Browser wallet (Phantom / Solflare / Backpack): connect and sign one message. Launching costs the
// launcher nothing, so the site never asks a wallet to send a transaction.
import { useState, useEffect, useCallback } from 'react'

export function provider() {
  if (typeof window === 'undefined') return null
  const p = window.phantom?.solana || window.solflare || window.backpack || window.solana || null
  if (p && (p.isPhantom || p.isSolflare || p.isBackpack || p.connect)) return p
  return null
}
export const hasWallet = () => !!provider()

export async function connect() {
  const p = provider()
  if (!p) throw new Error('No Solana wallet found. Install Phantom, Solflare or Backpack.')
  const r = await p.connect()
  return (r?.publicKey || p.publicKey).toString()
}
async function currentAccount() {
  const p = provider()
  if (!p) return null
  try { const r = await p.connect({ onlyIfTrusted: true }); return (r?.publicKey || p.publicKey)?.toString() || null } catch { return null }
}
async function disconnect() { try { await provider()?.disconnect() } catch {} }

/** Sign a UTF-8 message; returns the ed25519 signature as base58. */
export async function signMessageB58(message) {
  const p = provider()
  if (!p) throw new Error('No wallet connected')
  if (typeof p.signMessage !== 'function') throw new Error('This wallet cannot sign messages.')
  const r = await p.signMessage(new TextEncoder().encode(message), 'utf8')
  const sig = r?.signature || r
  const { default: bs58 } = await import('bs58')
  return bs58.encode(Uint8Array.from(sig))
}

const listeners = new Set()
let current = null
function set(a) { current = a; for (const l of listeners) l(a) }

/** One wallet state for the whole app. */
export function useWallet() {
  const [address, setAddress] = useState(current)
  useEffect(() => {
    listeners.add(setAddress)
    if (current == null) currentAccount().then(a => { if (a) set(a) })
    const p = provider()
    const onAcct = pk => set(pk ? pk.toString() : null)
    const onDisc = () => set(null)
    p?.on?.('accountChanged', onAcct)
    p?.on?.('disconnect', onDisc)
    return () => { listeners.delete(setAddress); p?.off?.('accountChanged', onAcct); p?.off?.('disconnect', onDisc) }
  }, [])
  const login = useCallback(async () => { const a = await connect(); set(a); return a }, [])
  const logout = useCallback(async () => { await disconnect(); set(null) }, [])
  return { address, login, logout, has: hasWallet() }
}
