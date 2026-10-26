import { useState, useEffect, useRef } from 'react'
import { api, go, Link, Pic, usePoll } from '../lib.jsx'
import { useWallet, signMessageB58 } from '../wallet.js'

const MAX_BYTES = 4 * 1024 * 1024
const bytes = s => new TextEncoder().encode(s).length // pump.fun counts bytes: é and emoji count double
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

async function readPicture(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('PNG, JPG, WebP or GIF')
  if (file.size > MAX_BYTES) throw new Error('up to 4 MB')
  const buf = await file.arrayBuffer()
  const sha = hex(await crypto.subtle.digest('SHA-256', buf))
  const url = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(file) })
  return { url, sha }
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

const CHECKS = [
  ['ticker', 'Ticker is free'],
  ['name', 'Name is free'],
  ['picture', 'Picture is new'],
  ['x', 'X link is free'],
]

export default function Launch() {
  const w = useWallet()
  const stats = usePoll('/stats', 30_000).data
  const [f, setF] = useState({ name: '', symbol: '', description: '', x: '', telegram: '', website: '' })
  const [pic, setPic] = useState(null)
  const [picErr, setPicErr] = useState(null)
  const [over, setOver] = useState(false)
  const [check, setCheck] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const fileRef = useRef(null)
  const set = k => e => setF(s => ({ ...s, [k]: k === 'symbol' ? e.target.value.replace(/^\$+/, '').toUpperCase().slice(0, 10) : e.target.value }))

  // live anti-vamp check, as they type
  const probe = useDebounced(JSON.stringify({ symbol: f.symbol, name: f.name, x: f.x, sha: pic?.sha }), 450)
  useEffect(() => {
    const p = JSON.parse(probe)
    if (!p.symbol && !p.name && !p.x && !p.sha) { setCheck({}); return }
    let live = true
    api('/check', { symbol: p.symbol, name: p.name, x: p.x, image: p.sha ? pic?.url : undefined })
      .then(r => { if (live) setCheck(r) })
      .catch(() => {})
    return () => { live = false }
    // pic.url changes together with pic.sha
  }, [probe]) // eslint-disable-line react-hooks/exhaustive-deps

  async function onFile(file) {
    setPicErr(null)
    if (!file) return
    try { setPic(await readPicture(file)) } catch (e) { setPicErr(e.message); setPic(null) }
  }

  const status = k => {
    const v = check[k]
    if (k === 'x' && !f.x) return { t: 'optional', c: '' }
    if (k === 'picture' && !pic) return { t: 'waiting', c: '' }
    if ((k === 'ticker' && !f.symbol) || (k === 'name' && !f.name)) return { t: 'waiting', c: '' }
    if (!v) return { t: 'checking', c: '' }
    return v === 'ok' ? { t: 'yes', c: 'ok' } : { t: 'taken', c: 'bad', why: v }
  }
  const refused = CHECKS.some(([k]) => status(k).c === 'bad')
  const ready = f.name.trim() && f.symbol.trim() && bytes(f.name) <= 32 && bytes(f.symbol) <= 10 && pic && !refused && !busy

  async function submit(e) {
    e.preventDefault()
    if (!ready) return
    setBusy(true); setMsg(null)
    try {
      const wallet = w.address || (await w.login())
      const ts = Date.now()
      const { message } = await api('/launch-message', { ...f, imageSha: pic.sha, ts })
      const signature = await signMessageB58(message)
      setMsg({ ok: true, text: 'Creating your coin on pump.fun…' })
      const r = await api('/launch', { ...f, wallet, signature, ts, image: pic.url })
      if (r.dryRun) { setMsg({ ok: true, text: `Dry run: the create for $${r.symbol} simulated cleanly and nothing was sent. Launches open soon.` }); return }
      go(`/coin/${r.coin.mint}`)
    } catch (err) {
      if (err.status === 202) setMsg({ ok: true, text: err.message })
      else setMsg({ ok: false, text: err.message || 'something went wrong' })
    } finally { setBusy(false) }
  }

  const preview = { name: f.name || 'Your coin', symbol: f.symbol || 'TICKER', image: pic?.url }
  const minSol = stats?.rules?.launcherMinSol
  return (
    <div className="page">
      <Link to="/" className="back">← Board</Link>
      <div className="head-block">
        <h1>Launch a coin</h1>
        <p>Free. The master wallet creates it on pump.fun and pays the rent. There is no dev buy, and every fee it earns buys it back and burns it.</p>
      </div>

      <div className="launch">
        <form className="form" onSubmit={submit}>
          <div className="two">
            <div className="field">
              <label>Name <em className={bytes(f.name) > 32 ? 'bad' : ''}>{bytes(f.name)}/32</em></label>
              <input value={f.name} maxLength={32} placeholder="Garlic" onChange={set('name')} />
              <div className={`note ${status('name').c}`}>{status('name').why || ''}</div>
            </div>
            <div className="field">
              <label>Ticker <em className={bytes(f.symbol) > 10 ? 'bad' : ''}>{bytes(f.symbol)}/10</em></label>
              <input value={f.symbol} placeholder="GARLIC" onChange={set('symbol')} className="num" />
              <div className={`note ${status('ticker').c}`}>{status('ticker').why || ''}</div>
            </div>
          </div>

          <div className="field">
            <label>Description <em>optional</em></label>
            <textarea value={f.description} maxLength={500} placeholder="What is it?" onChange={set('description')} />
          </div>

          <div className="field">
            <label>Picture <em>PNG, JPG, WebP or GIF, up to 4 MB</em></label>
            <div
              className={`drop${over ? ' over' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setOver(true) }}
              onDragLeave={() => setOver(false)}
              onDrop={e => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files?.[0]) }}
            >
              {pic ? <img src={pic.url} alt="" /> : <span>Drop a picture or click to choose one</span>}
              <small>{pic ? 'Click to change it' : 'A copy of another coin’s picture is refused, resized or recoloured too.'}</small>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => onFile(e.target.files?.[0])} />
            </div>
            <div className={`note ${picErr || status('picture').c === 'bad' ? 'bad' : ''}`}>{picErr || status('picture').why || ''}</div>
          </div>

          <div className="three">
            <div className="field">
              <label>X <em>optional</em></label>
              <input value={f.x} placeholder="x.com/…" onChange={set('x')} />
              <div className={`note ${status('x').c}`}>{status('x').why || ''}</div>
            </div>
            <div className="field">
              <label>Telegram <em>optional</em></label>
              <input value={f.telegram} placeholder="t.me/…" onChange={set('telegram')} />
            </div>
            <div className="field">
              <label>Website <em>optional</em></label>
              <input value={f.website} placeholder="https://…" onChange={set('website')} />
            </div>
          </div>

          {msg && <div className={`alert${msg.ok ? ' ok' : ''}`}>{msg.text}</div>}

          <button className="btn primary block" disabled={!ready}>
            {busy ? 'Launching…' : w.address ? 'Sign and launch' : 'Connect wallet and launch'}
          </button>
          <div className="note dim" style={{ fontSize: 12.5, marginTop: -8 }}>
            You sign a message, not a transaction. Nothing leaves your wallet{minSol ? `; it needs at least ${minSol} SOL in it to launch` : ''}. One launch per wallet per hour.
          </div>
        </form>

        <aside className="aside">
          <div className="panel">
            <h4>On the board</h4>
            <div className="preview">
              <Pic coin={preview} lg />
              <div>
                <div className="n">{preview.name}</div>
                <div className="sym num">${preview.symbol}</div>
              </div>
            </div>
          </div>
          <div className="panel">
            <h4>The anti-vamp check</h4>
            <div className="checks">
              {CHECKS.map(([k, label]) => { const s = status(k); return <div key={k}><span>{label}</span><span className={`st ${s.c}`}>{s.t}</span></div> })}
            </div>
          </div>
          <div className="panel">
            <h4>Where every fee goes</h4>
            <div className="flow">
              <span>Dev buy</span><b>none</b>
              <span>Creator fees</span><b className="burn">100% buy it back</b>
              <span>Then</span><b className="burn">burned, every 3 min</b>
              <span>Launch cost</span><b>free</b>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
