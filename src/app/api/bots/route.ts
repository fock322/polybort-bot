import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Proxy to mini-services (ports 3002/3003/3004) from server-side.
// This avoids CORS and XTransformPort issues — the Next.js server
// fetches localhost:PORT directly and returns JSON to the client.
//
// GET /api/bots               → all 3 bot statuses
// GET /api/bots?port=3003     → single bot status
// GET /api/bots?port=3003&path=/trades → arbitrary path

const PORTS = [3002, 3003, 3004]

async function fetchBot(port: number, path: string = '/'): Promise<any | null> {
  try {
    const r = await fetch(`http://localhost:${port}${path}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const portParam = url.searchParams.get('port')
  const pathParam = url.searchParams.get('path') || '/'

  // Single bot
  if (portParam) {
    const port = parseInt(portParam, 10)
    if (!PORTS.includes(port)) {
      return NextResponse.json({ error: 'Invalid port' }, { status: 400 })
    }
    const data = await fetchBot(port, pathParam)
    if (data === null) {
      return NextResponse.json({ error: 'Bot unavailable', port }, { status: 502 })
    }
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  // All bots
  const results = await Promise.all(
    PORTS.map(async (port) => [port, await fetchBot(port, '/')])
  )
  const bots: Record<number, any | null> = {}
  for (const [port, data] of results) {
    bots[port as number] = data
  }
  return NextResponse.json({ bots }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
