import { usePoll, Link, Pic, solFmt, tokens, ago, short, solscanTx } from '../lib.jsx'

export function Receipt({ r, coin }) {
  const c = coin || { symbol: r.symbol, image: `/api/img/${r.mint}` }
  return (
    <div className="receipt">
      <Link to={`/coin/${r.mint}`} className="what">
        <Pic coin={c} />
        <span>Bought back and burned <span className="num burn">{tokens(r.tokens)}</span> <span className="muted">${r.symbol}</span></span>
      </Link>
      <div className="num">{solFmt(r.sol, 5)} SOL</div>
      <div className="hide-sm muted">{r.route === 'amm' ? 'on PumpSwap' : 'on the curve'}</div>
      <div className="when"><a href={solscanTx(r.sig)} target="_blank" rel="noreferrer" title={r.sig}>{ago(r.at)} · {short(r.sig)}</a></div>
    </div>
  )
}

export default function Burns() {
  const { data } = usePoll('/receipts?limit=100', 8000)
  const stats = usePoll('/stats', 10_000).data
  return (
    <div className="page">
      <div className="head-block">
        <h1>Burns</h1>
        <p>Every fee a coin earns buys that coin back, and every token bought is burned in the same transaction. These are the receipts, newest first. Each one opens on Solscan.</p>
      </div>
      <section className="figures">
        <div><div className="v burn">{stats ? solFmt(stats.solBoughtBack, 4) : '…'}</div><div className="k">SOL bought back</div></div>
        <div><div className="v">{stats ? stats.buybacks : '…'}</div><div className="k">buybacks</div></div>
        <div><div className="v">{stats ? stats.burning : '…'}</div><div className="k">coins burning</div></div>
        <div><div className="v">{stats ? `${stats.rules?.crankMin ?? 3} min` : '…'}</div><div className="k">between burns</div></div>
      </section>
      <div className="rows">
        {(data?.receipts || []).map(r => <Receipt key={r.sig} r={r} />)}
      </div>
      {data && data.receipts.length === 0 && (
        <div className="empty"><h3>No burns yet.</h3><p>The first coin to trade starts the fire.</p><Link to="/launch" className="btn primary">Launch a coin</Link></div>
      )}
      {!data && <div className="empty"><p>Opening the receipts…</p></div>}
    </div>
  )
}
