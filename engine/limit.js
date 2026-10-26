// A small in-memory rate limiter for the public endpoints that cost us something real:
// pinning an image spends our IPFS quota, and preparing a launch writes a record and reads
// the chain. Neither needs a key to call, so without this a single visitor can run up a bill.
//
// In-memory on purpose: one engine, one process. It resets on restart, which is the right
// trade for something whose only job is to blunt a flood.
import { config } from './config.js'

const buckets = new Map() // key -> { count, resetAt }

/** The caller's address, trusting the proxy header only for its first hop. */
export function callerKey(req) {
  // Behind Vercel's rewrite the visitor is in x-vercel-forwarded-for; Caddy replaces
  // x-forwarded-for with the edge's address, which would put every visitor in one bucket.
  const vercel = String(req.get('x-vercel-forwarded-for') || '').split(',')[0].trim()
  const fwd = String(req.get('x-forwarded-for') || '').split(',')[0].trim()
  return vercel || fwd || req.ip || req.socket?.remoteAddress || 'unknown'
}

/**
 * Express middleware. `cost` lets an expensive route consume more of the same budget than
 * a cheap one, so one pin counts for more than one read.
 *
 * `windowMs` and `max` default to config but are arguments so the limiter can be exercised
 * on a short window without waiting a minute for it to roll over.
 */
export function rateLimit({ cost = 1, windowMs, max } = {}) {
  return (req, res, next) => {
    const limitWindow = windowMs ?? config.rateWindowMs
    const limitMax = max ?? config.rateMaxPerIp
    const key = callerKey(req)
    const now = Date.now()
    let b = buckets.get(key)
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + limitWindow }
      buckets.set(key, b)
    }
    b.count += cost
    if (b.count > limitMax) {
      const retry = Math.ceil((b.resetAt - now) / 1000)
      res.set('Retry-After', String(retry))
      return res.status(429).json({ error: `too many requests — try again in ${retry}s` })
    }
    next()
  }
}

/** Drop expired buckets so a long uptime cannot grow the map without bound. */
export function sweepLimiter() {
  const now = Date.now()
  for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k)
}

export const bucketCount = () => buckets.size
