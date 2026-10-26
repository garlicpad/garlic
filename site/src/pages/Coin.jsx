import { useState } from 'react'
import { usePoll, Link, Pic, Icon, usd, solFmt, tokens, pct, ago, copy, short, solscanTx, solscanAcct, pumpUrl, axiomUrl, dexUrl } from '../lib.jsx'
import { Receipt } from './Burns.jsx'

export default function Coin({ mint }) {
  const { data, error } = usePoll(`/coins/${encodeURIComponent(mint)}`, 8000)
  const [copied, setCopied] = useState(false)
  const c = data?.coin

  if (!c) {
    return (
      <div className="page">
        <Link to="/" className="back">← Board</Link>
        <div className="empty">{error?.status === 404 ? <><h3>No coin here.</h3><p>Nothing on {short(mint)} was launched on this board.</p></> : <p>Opening the coin…</p>}</div>
      </div>
    )
  }

  return (
    <div className="page">
      <Link to="/" className="back">← Board</Link>
      <div className="coin-top">
        <Pic coin={c} lg />
        <div>
          <h1>{c.name}<span className="num">${c.symbol}</span></h1>
          {c.description && <p>{c.description}</p>}
        </div>
      </div>

      <div className="coin-actions">
        <a className="btn primary" href={pumpUrl(c.mint)} target="_blank" rel="noreferrer">Trade on pump.fun</a>
        <a className="btn ghost" href={axiomUrl(c.mint)} target="_blank" rel="noreferrer">Axiom</a>
        <a className="btn ghost" href={dexUrl(c.mint)} target="_blank" rel="noreferrer">Chart</a>
        <button className="ca" onClick={async () => { if (await copy(c.mint)) { setCopied(true); setTimeout(() => setCopied(false), 1400) } }}>
          {copied ? 'copied' : `CA ${short(c.mint)}`}<Icon.copy />
        </button>
        {c.links?.x && <a className="btn ghost" href={c.links.x.startsWith('http') ? c.links.x : `https://x.com/${c.links.x.replace(/^@/, '')}`} target="_blank" rel="noreferrer">X</a>}
        {c.links?.telegram && <a className="btn ghost" href={c.links.telegram} target="_blank" rel="noreferrer">Telegram</a>}
        {c.links?.website && <a className="btn ghost" href={c.links.website} target="_blank" rel="noreferrer">Website</a>}
      </div>

      <section className="facts">
        <div><div className="v">{usd(c.mcapUsd)}</div><div className="k">market cap</div></div>
        <div><div className="v">{c.graduated ? 'graduated' : pct(c.progress, 1)}</div><div className="k">{c.graduated ? 'trading on PumpSwap' : 'of the curve sold'}</div></div>
        <div><div className="v burn">{pct(c.burnedPct, 2)}</div><div className="k">of the supply burned</div></div>
        <div><div className="v burn">{solFmt(c.burn.sol, 4)}</div><div className="k">SOL of fees bought it back</div></div>
      </section>

      <div className="section-title"><h2>Burn receipts</h2><span>{c.burn.count} buybacks · {tokens(c.burn.tokens)} ${c.symbol} burned</span></div>
      <div className="rows">
        {(data.receipts || []).map(r => <Receipt key={r.sig} r={r} coin={c} />)}
      </div>
      {(!data.receipts || data.receipts.length === 0) && (
        <div className="empty" style={{ padding: '40px 0' }}><p>No fees yet. The first trade starts the first burn.</p></div>
      )}

      <div style={{ marginTop: 40 }}>
        <div className="section-title"><h2>On-chain</h2></div>
        <div className="keyline"><span>Mint</span><a href={solscanAcct(c.mint)} target="_blank" rel="noreferrer">{c.mint}</a></div>
        <div className="keyline"><span>Creator (this coin’s own fee key: its fees can only buy this coin)</span><a href={solscanAcct(c.coinKey)} target="_blank" rel="noreferrer">{short(c.coinKey)}</a></div>
        <div className="keyline"><span>Launched by</span><a href={solscanAcct(c.launcher)} target="_blank" rel="noreferrer">{short(c.launcher)}</a></div>
        {c.sig && <div className="keyline"><span>Created {ago(c.launchedAt)}, no dev buy</span><a href={solscanTx(c.sig)} target="_blank" rel="noreferrer">{short(c.sig)}</a></div>}
      </div>
    </div>
  )
}
