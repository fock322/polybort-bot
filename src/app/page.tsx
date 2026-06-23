'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

type StrategyKey = 'contrarian' | 'momentum' | 'smart-money'

const STRATEGIES: { key: StrategyKey; port: number; label: string; color: string; emoji: string }[] = [
  { key: 'contrarian', port: 3002, label: 'Contrarian', color: '#3b82f6', emoji: '🔄' },
  { key: 'momentum', port: 3003, label: 'Momentum', color: '#f59e0b', emoji: '📈' },
  { key: 'smart-money', port: 3004, label: 'Smart Money', color: '#22c55e', emoji: '🐋' },
]

interface BotStatus {
  balance: number
  totalPnl: number
  realizedPnl: number
  unrealizedPnl: number
  tradeCount: number
  positionCount: number
  running: boolean
  strategy: string
  btcPrice: number
  circuitBreaker: boolean
}

export default function Home() {
  const [active, setActive] = useState<StrategyKey>('momentum')
  const [statuses, setStatuses] = useState<Record<string, BotStatus | null>>({
    'contrarian': null, 'momentum': null, 'smart-money': null,
  })
  const [lastUpdate, setLastUpdate] = useState<number>(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/bots', { cache: 'no-store' })
      if (!r.ok) return
      const data = await r.json()
      const results: Record<string, BotStatus | null> = {
        'contrarian': null, 'momentum': null, 'smart-money': null,
      }
      for (const s of STRATEGIES) {
        const d = data.bots?.[s.port]
        if (d) {
          results[s.key] = {
            balance: d.balance ?? 0,
            totalPnl: d.totalPnl ?? 0,
            realizedPnl: d.realizedPnl ?? 0,
            unrealizedPnl: d.unrealizedPnl ?? 0,
            tradeCount: d.tradeCount ?? 0,
            positionCount: d.positionCount ?? 0,
            running: !!d.running,
            strategy: d.strategy ?? s.key,
            btcPrice: d.btcPrice ?? 0,
            circuitBreaker: !!d.circuitBreaker,
          }
        }
      }
      setStatuses(results)
      setLastUpdate(Date.now())
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    // Defer first fetch to avoid setState during render phase
    const t = setTimeout(fetchStatus, 0)
    const id = setInterval(fetchStatus, 5000)
    const onVis = () => { if (document.visibilityState === 'visible') fetchStatus() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearTimeout(t); clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [fetchStatus])

  const activeStrategy = STRATEGIES.find(s => s.key === active)!
  // Dashboard HTML via gateway XTransformPort — the dashboard's own JS
  // detects XTransformPort in query and uses it for all its internal fetches.
  const dashboardUrl = `/dashboard?XTransformPort=${activeStrategy.port}`

  const refreshIframe = () => {
    if (iframeRef.current) {
      // reload iframe
      const src = iframeRef.current.src
      iframeRef.current.src = 'about:blank'
      setTimeout(() => { if (iframeRef.current) iframeRef.current.src = src }, 50)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0b',
      color: '#e4e4e7',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Header */}
      <header style={{
        borderBottom: '1px solid #27272a',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '10px',
        background: '#111113',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '18px' }}>🤖</span>
          <div>
            <h1 style={{ fontSize: '14px', fontWeight: 700, margin: 0 }}>Polymarket MM Bot</h1>
            <p style={{ fontSize: '10px', color: '#71717a', margin: 0 }}>
              3 стратегии • обновлено: {lastUpdate ? new Date(lastUpdate).toLocaleTimeString('ru-RU') : '—'}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {STRATEGIES.map(s => {
            const st = statuses[s.key]
            const totalPnl = st?.totalPnl ?? 0
            const pnlColor = totalPnl > 0 ? '#22c55e' : totalPnl < 0 ? '#ef4444' : '#71717a'
            return (
              <button
                key={s.key}
                onClick={() => setActive(s.key)}
                style={{
                  padding: '7px 12px',
                  border: active === s.key ? `2px solid ${s.color}` : '2px solid #27272a',
                  background: active === s.key ? `${s.color}20` : '#18181b',
                  color: active === s.key ? s.color : '#a1a1aa',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  transition: 'all 0.15s',
                }}
              >
                <span>{s.emoji}</span>
                <span>{s.label}</span>
                {st && (
                  <span style={{ fontSize: '10px', color: pnlColor, fontWeight: 700 }}>
                    {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
                  </span>
                )}
              </button>
            )
          })}
          <button
            onClick={refreshIframe}
            title="Обновить дашборд"
            style={{
              padding: '7px 10px',
              border: '2px solid #27272a',
              background: '#18181b',
              color: '#a1a1aa',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >↻</button>
        </div>
      </header>

      {/* Summary cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: '8px',
        padding: '10px 16px',
        background: '#0f0f11',
        borderBottom: '1px solid #27272a',
      }}>
        {STRATEGIES.map(s => {
          const st = statuses[s.key]
          const pnl = st?.totalPnl ?? 0
          const pnlColor = pnl > 0 ? '#22c55e' : pnl < 0 ? '#ef4444' : '#71717a'
          return (
            <div
              key={s.key}
              onClick={() => setActive(s.key)}
              style={{
                padding: '10px 12px',
                background: active === s.key ? '#18181b' : '#0c0c0e',
                border: active === s.key ? `1px solid ${s.color}60` : '1px solid #27272a',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '11px', color: '#a1a1aa', fontWeight: 600 }}>{s.emoji} {s.label}</span>
                <span style={{
                  fontSize: '9px',
                  padding: '2px 5px',
                  borderRadius: '3px',
                  background: st?.running ? '#22c55e20' : '#71717a20',
                  color: st?.running ? '#22c55e' : '#71717a',
                }}>
                  {st?.running ? '● LIVE' : st ? '○ STOP' : '○ OFFLINE'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div>
                  <div style={{ fontSize: '16px', fontWeight: 700 }}>
                    {st ? `$${st.balance.toFixed(2)}` : '$—'}
                  </div>
                  <div style={{ fontSize: '9px', color: '#71717a' }}>баланс</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: pnlColor }}>
                    {st ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}` : '—'}
                  </div>
                  <div style={{ fontSize: '9px', color: '#71717a' }}>PnL</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '14px', fontWeight: 700 }}>
                    {st?.tradeCount ?? 0}
                  </div>
                  <div style={{ fontSize: '9px', color: '#71717a' }}>трейдов</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '14px', fontWeight: 700 }}>
                    {st?.positionCount ?? 0}
                  </div>
                  <div style={{ fontSize: '9px', color: '#71717a' }}>позиций</div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Active dashboard iframe */}
      <div style={{ flex: 1, position: 'relative', background: '#0f1117', minHeight: '500px' }}>
        <iframe
          ref={iframeRef}
          key={activeStrategy.port}
          src={dashboardUrl}
          title={`${activeStrategy.label} dashboard`}
          style={{
            position: 'absolute',
            top: 0, left: 0, width: '100%', height: '100%',
            border: 'none',
          }}
        />
      </div>
    </div>
  )
}
