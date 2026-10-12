import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptFriendRequests, sessionBody } from './xbox.ts'

test('a friend request that cannot be accepted is declined and does not block later ones', async (t) => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method} ${url.match(/xuid\((\d+)\)/)?.[1] ?? 'list'}`)
    if (init?.method === 'GET') return Response.json({ people: [{ xuid: '1', gamertag: 'A' }, { xuid: '2', gamertag: 'B' }] })
    if (init?.method === 'PUT' && url.includes('xuid(1)')) return new Response('{"code":1049}', { status: 403 })
    return Response.json({})
  })
  await acceptFriendRequests('XBL3.0 x=;')
  assert.deepEqual(calls, ['GET list', 'PUT 1', 'DELETE 1', 'PUT 2'])
})

test('sessionBody publishes an exact uint64 NetherNetId and a joinable member count', () => {
  const info = { name: 'Server', level: 'World', version: '1.26.52', protocol: 2193, players: 0, maxPlayers: 1, gameType: 1 }
  const body = sessionBody({ xuid: '2535', connectionId: 'c', netherNetId: 9223372036854775807n, pmsgId: 'p', info, nonces: {} })
  assert.match(body, /"NetherNetId":9223372036854775807,/)
  const custom = JSON.parse(body).properties.custom
  assert.deepEqual(
    [custom.MemberCount, custom.MaxMemberCount, custom.worldType, custom.SupportedConnections[0].ConnectionType],
    [1, 2, 'Creative', 7],
  )
})
