import { randomUUID } from 'node:crypto'

export const SCID = '4fc10100-5f7a-4470-899b-280835760c07'
export const TEMPLATE = 'MinecraftLobby'

/** BDS `GET /v1/join` (only filled when `enable-lan-visibility=true`). */
export interface BdsInfo {
  name: string
  level: string
  version: string
  protocol: number
  players: number
  maxPlayers: number
  gameType: number
}

export interface SessionState {
  xuid: string
  connectionId: string
  netherNetId: bigint
  pmsgId: string
  info: BdsInfo
  nonces: Record<string, string>
}

/** Node's WebSocket (undici) accepts headers; the DOM typings pulled in by nethernet don't know that. */
export const openWebSocket = (url: string, headers: Record<string, string>) =>
  new WebSocket(url, { headers } as unknown as string[])

export async function xbl(auth: string, url: string, method = 'GET', body?: string, contract = '107') {
  const res = await fetch(url, {
    method,
    body,
    headers: { authorization: auth, 'x-xbl-contract-version': contract, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`)
  return res
}

/** MPSD session body, as current Minecraft hosts publish it (JSON-RPC signaling = ConnectionType 7). */
export function sessionBody(s: SessionState) {
  const players = Math.max(s.info.players, 1) // 0 hides the join button
  const body = {
    properties: {
      system: { joinRestriction: 'followed', readRestriction: 'followed', closed: false },
      custom: {
        BroadcastSetting: 3,
        CrossPlayDisabled: false,
        Joinability: 'joinable_by_friends',
        LanGame: false,
        MaxMemberCount: Math.max(s.info.maxPlayers, players + 1),
        MemberCount: players,
        OnlineCrossPlatformGame: true,
        SupportedConnections: [
          { ConnectionType: 7, HostIpAddress: '', HostPort: 0, NetherNetId: s.netherNetId.toString(), PmsgId: s.pmsgId },
        ],
        TitleId: 0,
        TransportLayer: 2,
        levelId: 'level',
        hostName: s.info.level,
        ownerId: s.xuid,
        rakNetGUID: '',
        worldName: s.info.name,
        worldType: ['Survival', 'Creative', 'Adventure'][s.info.gameType] ?? 'Survival',
        protocol: s.info.protocol,
        version: s.info.version,
        isEditorWorld: false,
        isHardcore: false,
        nonces: s.nonces,
      },
    },
    members: {
      me: {
        constants: { system: { xuid: s.xuid, initialize: true } },
        properties: {
          system: {
            active: true,
            connection: s.connectionId,
            subscription: { id: randomUUID(), changeTypes: ['everything'] },
          },
        },
      },
    },
  }
  // NetherNetId is a uint64 JSON number; a JS number would lose precision.
  return JSON.stringify(body).replace(/"NetherNetId":"(\d+)"/, '"NetherNetId":$1')
}

export interface Rta {
  connectionId: string
  readonly closed: boolean
  close(): void
}

/** Real-Time Activity socket: keeps our session membership active and reports session changes. */
export function connectRta(auth: string, onSessionChange: () => void) {
  return new Promise<Rta>((resolve, reject) => {
    const ws = openWebSocket('wss://rta.xboxlive.com/connect', { authorization: auth })
    const timer = setTimeout(() => {
      reject(new Error('RTA: no ConnectionId'))
      ws.close()
    }, 10_000)
    ws.onopen = () => ws.send(JSON.stringify([1, 1, 'https://sessiondirectory.xboxlive.com/connections/']))
    ws.onclose = (e) => {
      clearTimeout(timer)
      reject(new Error(`RTA closed: ${e.code} ${e.reason}`))
    }
    ws.onmessage = ({ data }) => {
      let message
      try {
        message = JSON.parse(String(data)) // a throw here would crash the process
      } catch {
        return
      }
      if (message[0] === 1 && message[1] === 1) {
        clearTimeout(timer)
        const connectionId = message[4]?.ConnectionId
        if (message[2] !== 0 || !connectionId) {
          ws.close()
          return reject(new Error(`RTA subscribe failed: ${data}`))
        }
        resolve({
          connectionId,
          get closed() {
            return ws.readyState > WebSocket.OPEN
          },
          close: () => ws.close(),
        })
      } else if (message[0] === 3 && message[2]?.ncid) onSessionChange()
    }
  })
}
