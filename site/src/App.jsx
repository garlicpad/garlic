import { useState } from 'react'
import { useRoute, Link, go, Icon, BRAND } from './lib.jsx'
import { useWallet } from './wallet.js'
import Board from './pages/Board.jsx'
import Launch from './pages/Launch.jsx'
import Burns from './pages/Burns.jsx'
import Coin from './pages/Coin.jsx'
import How from './pages/How.jsx'

const NAV = [
  { to: '/', label: 'Board', icon: Icon.board },
  { to: '/launch', label: 'Launch a coin', icon: Icon.plus },
  { to: '/burns', label: 'Burns', icon: Icon.flame },
  { to: '/how', label: 'How it works', icon: Icon.book },
]

function WalletButton() {
  const w = useWallet()
  const [err, setErr] = useState(null)
  if (w.address) {
    return <button className="btn ghost small num" title="Disconnect" onClick={w.logout}>{w.address.slice(0, 4)}…{w.address.slice(-4)}</button>
  }
  return (
    <button className="btn ghost small" title={err || ''} onClick={() => w.login().catch(e => setErr(e.message))}>
      Connect wallet
    </button>
  )
}

export default function App() {
  const path = useRoute()
  const [q, setQ] = useState('')
  let page
  if (path === '/' || path === '') page = <Board q={q} />
  else if (path === '/launch') page = <Launch />
  else if (path === '/burns') page = <Burns />
  else if (path === '/how') page = <How />
  else if (path.startsWith('/coin/')) page = <Coin mint={decodeURIComponent(path.slice(6))} />
  else page = <div className="page"><div className="empty"><h3>Nothing here.</h3><p>That page does not exist.</p><Link className="btn ghost" to="/">Back to the board</Link></div></div>

  const on = to => (to === '/' ? path === '/' || path.startsWith('/coin/') : path.startsWith(to))
  return (
    <div className="shell">
      <aside className="side">
        <Link to="/" className="brand"><img src="/icon-192.png" alt="" /><b>{BRAND}</b></Link>
        <nav className="nav">
          {NAV.map(n => <Link key={n.to} to={n.to} className={on(n.to) ? 'on' : ''}><n.icon />{n.label}</Link>)}
        </nav>
        <div className="grow" />
        <Link to="/launch" className="btn primary block" style={{ height: 42, fontSize: 14 }}>Launch a coin</Link>
        <div className="foot">
          <span>Coins trade on pump.fun.</span>
          <span>Not affiliated with pump.fun.</span>
        </div>
      </aside>
      <div className="main">
        <header className="top">
          <Link to="/" className="mobile-brand"><img src="/icon-192.png" alt="" /><b>{BRAND}</b></Link>
          <label className="search">
            <Icon.search />
            <input value={q} placeholder="Search coins, tickers, mints" onChange={e => { setQ(e.target.value); if (path !== '/') go('/') }} />
          </label>
          <span className="spacer" />
          <WalletButton />
        </header>
        {page}
      </div>
      <nav className="tabbar">
        {NAV.map(n => <Link key={n.to} to={n.to} className={on(n.to) ? 'on' : ''}><n.icon />{n.label.replace(' a coin', '').replace(' it works', '')}</Link>)}
      </nav>
    </div>
  )
}
