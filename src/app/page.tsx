'use client'

export default function Home() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      gap: '1rem',
      padding: '1rem',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <img src="/logo.svg" alt="Logo" style={{ width: '4rem', height: '4rem' }} />
      <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>Polymarket BTC MM Bot</h1>
      <p style={{ color: '#666', fontSize: '0.875rem' }}>
        Engine is running. Use API endpoints to interact.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '30rem' }}>
        {['/api', '/api/backtest', '/api/data'].map(p => (
          <code key={p} style={{
            background: '#f4f4f5', padding: '0.25rem 0.5rem', borderRadius: '4px',
            fontSize: '0.75rem', color: '#71717a'
          }}>{p}</code>
        ))}
      </div>
    </div>
  )
}
