import { useState } from 'react'
import { usePoll, useTick, Link, Pic, Icon, usd, solFmt, tokens, pct, ago, copy, short } from '../lib.jsx'

const SORTS = [
  ['new', 'New'],
  ['mcap', 'Market cap'],
  ['burned', 'Most burned'],
  ['graduating', 'About to graduate'],
]

function NextBurn({ crank }) {
  useTick(1000)
  if (!crank?.nextAt) return <span className="num">3:00</span>
  const s = Math.max(0, Math.round((crank.nextAt - Date.now()) / 1000))
  if (crank.running || s === 0) return <span className="num">now</span>
  return <span className="num">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
}

export function Row({ c }) {
  return (
    <Link to={`/coin/${c.mint}`} className="row">
      <div className="coin">
        <Pic coin={c} />
        <div className="t">
          <div className="n">{c.name}<span className="sym">${c.symbol}</span></div>
          <div className="s">{ago(c.launchedAt)} · by {c.launcherShort}</div>
        </div>
      </div>
      <div className="cell right">
        <div className="v">{usd(c.mcapUsd)}</div>
        <div className="sub">{c.graduated ? 'on PumpSwap' : 'market cap'}</div>
      </div>
      <div className="cell hide-sm">
        <div className="v">{c.graduated ? 'graduated' : pct(c.progress, 0)}</div>
        <div className={`bar${c.graduated ? ' grad' : ''}`}><i style={{ width: `${Math.round((c.graduated ? 1 : c.progress || 0) * 100)}%` }} /></div>
      </div>
      <div className="cell hide-sm">
        <div className={`v${c.burnedPct > 0 ? ' burn' : ''}`}>{pct(c.burnedPct, 2)}</div>
        <div className="sub">{c.burn.count ? `${tokens(c.burn.tokens)} burned` : 'no fees yet'}</div>
      </div>
      <div className="chev hide-sm"><Icon.chev /></div>
    </Link>
  )
}

function HeroCA({ stats }) {
  const [copied, setCopied] = useState(false)
  if (!stats?.coinMint) return null
  return (
    <button className="ca hero-ca" onClick={async () => { if (await copy(stats.coinMint)) { setCopied(true); setTimeout(() => setCopied(false), 1400) } }}>
      <b>${stats.coinSymbol || 'GARLIC'}</b>{copied ? 'copied' : short(stats.coinMint)}<Icon.copy />
    </button>
  )
}

export default function Board({ q }) {
  const [sort, setSort] = useState('new')
  const stats = usePoll('/stats', 10_000).data
  const query = q ? `&q=${encodeURIComponent(q)}` : ''
  const { data, error } = usePoll(`/coins?sort=${sort}&limit=100${query}`, 8000)
  const coins = data?.coins

  return (
    <div className="page">
      <section className="hero">
        <div>
          <h1>Launched fair.<br /><span>Built to last.</span></h1>
          <p>
            Fair launches on pump.fun. <b>One coin per ticker</b>, no dev buy, and <b>every fee the coin earns buys it back and burns it</b>, every three minutes.
          </p>
          <div className="cta">
            <Link to="/launch" className="btn primary">Launch a coin, free</Link>
            <Link to="/how" className="btn ghost">How it works</Link>
          </div>
          <HeroCA stats={stats} />
        </div>
        <div className="hero-art"><img src="/mark.png" alt="" /></div>
      </section>

      <section className="figures">
        <div><div className="v">{stats ? stats.coins : '…'}</div><div className="k">coins live</div></div>
        <div><div className="v burn">{stats ? solFmt(stats.solBoughtBack, 3) : '…'}</div><div className="k">SOL bought back and burned</div></div>
        <div><div className="v">{stats ? stats.buybacks : '…'}</div><div className="k">buybacks</div></div>
        <div><div className="v"><span className="live" /><NextBurn crank={stats?.crank} /></div><div className="k">until the next burn</div></div>
      </section>

      <div className="board-head">
        <h2>{q ? `Results for “${q}”` : 'The board'}</h2>
        <div className="tabs">
          {SORTS.map(([k, label]) => <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{label}</button>)}
        </div>
      </div>

      <div className="rows">
        <div className="row head">
          <div>Coin</div><div>Market cap</div><div>Curve</div><div>Burned</div><div />
        </div>
        {coins && coins.map(c => <Row key={c.mint} c={c} />)}
      </div>

      {coins && coins.length === 0 && (
        <div className="empty">
          <h3>{q ? 'No coin by that name.' : 'The board is empty.'}</h3>
          <p>{q ? 'Its ticker is still free.' : 'The first coin is yours.'}</p>
          <Link to="/launch" className="btn primary">Launch a coin</Link>
        </div>
      )}
      {!coins && !error && <div className="empty"><p>Opening the board…</p></div>}
      {!coins && error && <div className="empty"><p>The board is not answering right now. It retries by itself.</p></div>}
    </div>
  )
}
