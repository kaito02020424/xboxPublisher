import { randomUUID } from 'node:crypto'
import { openWebSocket } from './xbox.ts'

export interface Signaling {
  /** Send a NetherNet signal string ("CONNECTRESPONSE <id> <sdp>") to a peer's messaging id. */
  send(to: string, message: string): void
  readonly closed: boolean
  close(): void
}

type OnSignal = (from: string, peerNetherNetId: string, message: string) => void

/** Host side of Mojang's franchise signaling (JSON-RPC 2.0), used by friend joins. */
export function connectSignaling(mcToken: string, netherNetId: bigint, onSignal: OnSignal) {
  return new Promise<Signaling>((resolve, reject) => {
    const ws = openWebSocket('wss://signal.franchise.minecraft-services.net/ws/v1.0/messaging/connect', {
      authorization: mcToken,
      'session-id': randomUUID(),
      'request-id': randomUUID(),
    })
    const request = (method: string, params: object) =>
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }))
    const sendTo = (to: string, method: string, params: object) =>
      request('Signaling_SendClientMessage_v1_0', {
        toPlayerId: to,
        messageId: randomUUID(),
        message: JSON.stringify({ jsonrpc: '2.0', method, params }),
      })
    const ping = setInterval(() => request('System_Ping_v1_0', {}), 30_000)
    const timer = setTimeout(() => {
      reject(new Error('signaling: no TURN credentials'))
      ws.close()
    }, 15_000)

    ws.onopen = () => request('Signaling_TurnAuth_v1_0', {})
    ws.onclose = (e) => {
      clearInterval(ping)
      clearTimeout(timer)
      reject(new Error(`signaling closed: ${e.code} ${e.reason}`))
    }
    ws.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(String(data))
        // Server requests (pings, deliveries) must be acknowledged or delivery is cancelled.
        if (msg.method && msg.id != null) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }))
        if (msg.error) console.warn('signaling error:', JSON.stringify(msg.error))
        if (msg.result?.TurnAuthServers) { // hosts request TURN credentials once connected
          clearTimeout(timer)
          resolve({
            send: (to, message) => sendTo(to, 'Signaling_WebRtc_v1_0', { netherNetId: netherNetId.toString(), message }),
            get closed() {
              return ws.readyState > WebSocket.OPEN
            },
            close: () => ws.close(),
          })
        }
        if (msg.method !== 'Signaling_ReceiveMessage_v1_0') return
        for (const { From, Message, Id } of [msg.params].flat()) {
          const inner = JSON.parse(Message)
          if (inner.method !== 'Signaling_WebRtc_v1_0') continue // never ack an ack
          if (Id) sendTo(From, 'Signaling_DeliveryNotification_V1_0', { messageId: Id })
          onSignal(From, inner.params.netherNetId, inner.params.message)
        }
      } catch (error) {
        console.warn('signaling: bad message:', error)
      }
    }
  })
}
