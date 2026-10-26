import { Link, usePoll, short, solscanAcct } from '../lib.jsx'

export default function How() {
  const stats = usePoll('/stats', 60_000).data
  return (
    <div className="page">
      <div className="head-block">
        <h1>Same pump.fun.<br />Better launch.</h1>
        <p>Every coin here is a real pump.fun coin from its first block: same curve, same graduation, same apps. What changes is who launches it, what is allowed, and where its fees go.</p>
      </div>

      <div className="rules">
        <div className="rule">
          <div className="i">01</div>
          <div>
            <h3>One master wallet launches everything.</h3>
            <p>Every coin is created by the same wallet{stats?.master ? <> (<a href={solscanAcct(stats.master)} target="_blank" rel="noreferrer" className="num">{short(stats.master)}</a>)</> : ''}, which pays the rent. There is <b>no dev wallet and no dev buy</b>, so there is no bag to dump and no dev in block 0. Launching is free: you sign a message, not a transaction.</p>
          </div>
        </div>

        <div className="rule">
          <div className="i">02</div>
          <div>
            <h3>The create goes out privately.</h3>
            <p>The create transaction is sent only to the Jito block engine, never through the public path, and the mint address is not shown anywhere until it exists. Nobody can ride inside the create. After that it trades like any pump.fun coin: bots can still buy in the next block, and we do not promise otherwise.</p>
          </div>
        </div>

        <div className="rule">
          <div className="i">03</div>
          <div>
            <h3>One coin per ticker, forever.</h3>
            <p>Before anything is signed, a new coin is checked against every coin on the board. <b>The ticker must be new</b>: case, spaces, lookalike letters, leetspeak, doubled letters and the bits vamps bolt on (AI, INU, SOL, COIN, a 2, a leading THE) all fold into one. The name cannot be a copy with “official”, “real” or a “2” added. The picture cannot be a resized or recoloured copy. An X post or account backs one coin. A ticker already trading somewhere with real money is refused too.</p>
            <div className="fold">
              <span>$P3PE</span><span className="eq">=</span><span>$pepe</span><span className="eq">=</span><span>$PЕPE</span><span className="eq">=</span><span>$PEPPE</span><span className="eq">=</span><span>$PEPE AI</span><span className="eq">=</span><span>$THE PEPE 2</span><span className="eq">=</span><span className="k">$PEPE</span>
            </div>
          </div>
        </div>

        <div className="rule">
          <div className="i">04</div>
          <div>
            <h3>Fees buy it back. Then burn it.</h3>
            <p>Each coin’s creator on pump.fun is <b>its own key</b>, so pump.fun pays that coin’s fees to that key and nowhere else: the amounts are exact, not estimated. Every three minutes, one transaction collects them, <b>buys the coin with all of it</b>, and <b>burns every token it bought</b>. It lands whole or not at all. The master wallet pays the network fees, so the coin’s fees go 100% to the buyback.</p>
            <p>The supply only goes down. Every burn is a receipt you can open on Solscan, on the <Link to="/burns">Burns</Link> page.</p>
          </div>
        </div>

        <div className="rule">
          <div className="i">05</div>
          <div>
            <h3>What to trust, plainly.</h3>
            <p>The coin keys are derived from the master wallet’s key, which we hold: the buyback runs on our engine, not in a contract. Everything it does is public, and each coin’s creator address is on its page so anyone can check where its fees went.</p>
            <p>pump.fun sets the fees and the curve. Coins are made by their launchers, not by us. Nothing here is financial advice, and we are not affiliated with pump.fun.</p>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 34 }}>
        <Link to="/launch" className="btn primary">Launch a coin</Link>
      </div>
    </div>
  )
}
