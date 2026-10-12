import { generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { Relay } from '@nethernet-proxy/relay'
import { SignalStructure, SignalType, type Identity } from 'nethernet'
import prismarineAuth from 'prismarine-auth'
import { connectSignaling, type Signaling } from './signaling.ts'
import { acceptFriendRequests, connectRta, SCID, sessionBody, TEMPLATE, xbl, type BdsInfo, type Rta } from './xbox.ts'

const { Authflow, Titles } = prismarineAuth
const config = JSON.parse(await readFile('config.json', 'utf8')) as { server: string; autoAcceptFriends?: boolean }
const bdsUrl = new URL(config.server)

const auth = new Authflow(
  'xboxPublisher',
  '.auth',
  { flow: 'live', authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo' },
  (code) => console.log(code.message),
)
const xblAuth = async () => {
  const token = await auth.getXboxToken()
  return { header: `XBL3.0 x=${token.userHash};${token.XSTSToken}`, xuid: token.userXUID }
}
const jwt = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

// Offers to BDS carry this account's multiplayer token; answers to friends are self-signed by the relay.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
const bdsIdentity: Identity = { privateKey, token: '', domain: 'https://authorization.franchise.minecraft-services.net/' }
const relay = new Relay({
  serverUrl: bdsUrl,
  clientSideIdentity: { privateKey, token: '', domain: 'self' },
  serverSideIdentity: bdsIdentity,
  log: process.env.DEBUG ? (event, fields) => console.debug(event, fields) : undefined,
})
relay.on('sessionReady', (s) => console.log(`joined: ${s.verifiedSignaling?.gamertag} (${s.verifiedSignaling?.xuid})`))
relay.on('sessionClose', (s, reason) => console.log(`left: ${s.verifiedSignaling?.gamertag ?? s.connectionId} (${reason})`))
relay.on('signalingRejected', (id, reason) => console.warn(`rejected offer ${id}: ${reason}`))

const sessionName = randomUUID()
const sessionUrl = `https://sessiondirectory.xboxlive.com/serviceconfigs/${SCID}/sessionTemplates/${TEMPLATE}/sessions/${sessionName}`
const netherNetId = randomBytes(8).readBigUInt64BE() >> 1n // positive int64, like other hosts publish
const nonces: Record<string, string> = {}
let info: BdsInfo | undefined
let rta: Rta | undefined
let signaling: Signaling | undefined
let pmsgId = ''
let handlePosted = false
let lastPresence = 0
let stopping = false

async function bdsInfo(): Promise<BdsInfo> {
  const target = `BDS ${bdsUrl.host}/v1/join (needs transport=nethernet and enable-lan-visibility=true)`
  const res = await fetch(new URL('/v1/join', bdsUrl), { signal: AbortSignal.timeout(5_000) }).catch((error) => {
    throw new Error(`${target}: ${error.cause?.message ?? error.message}`)
  })
  const text = await res.text()
  if (!res.ok || !text) throw new Error(`${target}: ${res.status} "${text}"`)
  return JSON.parse(text)
}

async function putSession() {
  const { header, xuid } = await xblAuth()
  if (stopping) throw new Error('shutting down') // don't rejoin after the leave PUT
  await xbl(header, sessionUrl, 'PUT', sessionBody({ xuid, connectionId: rta!.connectionId, netherNetId, pmsgId, info: info!, nonces }))
}

// Clients wait for a nonce under their XUID before sending CONNECTREQUEST.
async function syncNonces() {
  const { header, xuid } = await xblAuth()
  const session = await (await xbl(header, sessionUrl)).json()
  const members: string[] = Object.values(session.members ?? {})
    .map((m: any) => m.constants?.system?.xuid)
    .filter((x) => x && x !== xuid)
  let changed = false
  for (const x of Object.keys(nonces)) {
    if (members.includes(x)) continue
    delete nonces[x]
    changed = true
  }
  for (const x of members) {
    if (nonces[x]) continue
    nonces[x] = randomBytes(8).toString('hex')
    changed = true
  }
  if (changed) await putSession()
}

// Friend leg: franchise signals go straight into the relay's NetherNet server.
const early = new Map<bigint, SignalStructure[]>()
function onSignal(from: string, peerNetherNetId: string, message: string) {
  const signal = SignalStructure.fromString(message)
  signal.networkId = BigInt(peerNetherNetId)
  const respond = (reply: SignalStructure) => {
    if (reply.type !== SignalType.CandidateAdd) signaling?.send(from, reply.toString()) // werift answers carry every candidate
  }
  const endpoint = relay.clientEndpoint
  const warn = (error: unknown) => console.warn(`signal ${signal.type} ${signal.connectionId}:`, error)
  if (signal.type === SignalType.ConnectRequest) {
    // The relay drops candidates that arrive while the offer is still being verified.
    early.set(signal.connectionId, [])
    endpoint
      .handleOffer(signal, respond, signaling?.iceServers)
      .catch(warn)
      .finally(() => {
        for (const c of early.get(signal.connectionId) ?? []) endpoint.handleCandidate(c, respond).catch(warn)
        early.delete(signal.connectionId)
      })
  } else if (signal.type === SignalType.CandidateAdd) {
    const queue = early.get(signal.connectionId)
    if (queue) queue.push(signal)
    else endpoint.handleCandidate(signal, respond).catch(warn)
  } else if (signal.type === SignalType.ConnectError) {
    relay.closeSession(signal.connectionId, `connecterror:${signal.data}`).catch(warn)
  }
}

async function update() {
  try {
    info = await bdsInfo()
  } catch (error) {
    if (!info) throw error
    console.warn((error as Error).message) // keep advertising the last known state
  }
  const { header, xuid } = await xblAuth()
  const { mcToken } = await auth.getMinecraftBedrockServicesToken({ version: info.version })
  if (!bdsIdentity.token || jwt(bdsIdentity.token).exp * 1000 - Date.now() < 3_600_000) {
    const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    // prismarine-auth 3.1.1 types say KeyObject, but the service needs this base64 string.
    const token = await auth.getMinecraftBedrockMultiplayerToken(spki as unknown as KeyObject, { version: info.version })
    if (!token) throw new Error('no multiplayer token')
    bdsIdentity.token = token
  }
  if (!signaling || signaling.closed) {
    signaling = await connectSignaling(mcToken, netherNetId, onSignal)
    pmsgId = jwt(mcToken.split(' ')[1]).pmid
    console.log('connected to franchise signaling')
  }
  if (!rta || rta.closed) {
    rta = await connectRta(header, () => void syncNonces().catch((e) => console.warn('nonce sync:', e.message)))
    handlePosted = false
    console.log('connected to Xbox RTA')
  }
  await putSession()
  if (!handlePosted) {
    const sessionRef = { scid: SCID, templateName: TEMPLATE, name: sessionName }
    await xbl(header, 'https://sessiondirectory.xboxlive.com/handles', 'POST', JSON.stringify({ version: 1, type: 'activity', sessionRef }))
    handlePosted = true
    console.log(`advertising "${info.name}" (${info.version}) to friends of ${xuid}, proxying to ${bdsUrl.host}`)
  }
  if (Date.now() - lastPresence > 300_000) {
    await xbl(header, `https://userpresence.xboxlive.com/users/xuid(${xuid})/devices/current/titles/current`, 'POST', '{"state":"active"}', '3')
    lastPresence = Date.now()
  }
  if (config.autoAcceptFriends ?? true) await acceptFriendRequests(header).catch((e) => console.warn('friend requests:', e.message))
}

for (const event of ['SIGINT', 'SIGTERM'] as const) {
  process.once(event, async () => {
    stopping = true
    console.log('leaving session...')
    try {
      await xbl((await xblAuth()).header, sessionUrl, 'PUT', '{"members":{"me":null}}')
    } catch {}
    rta?.close()
    signaling?.close()
    await relay.close().catch(() => {})
    process.exit(0)
  })
}

for (;;) {
  await update().catch((error) => console.error('update failed:', error.message))
  await sleep(30_000)
}
