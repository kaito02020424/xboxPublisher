import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionBody } from './xbox.ts'

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
