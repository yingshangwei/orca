import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { jwtVerify } from 'jose'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { z } from 'zod'
import {
  buildHostProofMacInput,
  HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  RELAY_PROTOCOL_LIMITS
} from '@orca-cloud/relay-contract'
import { RelayAssignmentStore } from './assignment-store.js'
import { reconcileCellAdmissionAtStartup } from './cell-admission-startup.js'
import { loadRelayConfig } from './config.js'
import { openInMemoryRelayDatabase, openRelayDatabase } from './database.js'
import { createRelayServer } from './relay-server.js'
import { loadSelfHostedRelayAuth } from './self-hosted-relay-auth.js'
import { nextFrame } from './test-fixtures/reserve-mode-cell.js'

const TokenResponse = z.object({ relayToken: z.string(), expiresAt: z.number() })
const AssignmentResponse = z.object({ assignmentEpoch: z.number(), cellUrl: z.string() })

describe('self-hosted relay authentication and reconnect', () => {
  const cleanup: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'orca-self-hosted-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const keyPair = nacl.box.keyPair()
    const hostPublicKeyB64 = Buffer.from(keyPair.publicKey).toString('base64')
    const relayHostId = createHash('sha256')
      .update(keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const accessKey = randomBytes(32).toString('base64url')
    const authFile = join(directory, 'auth.json')
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    writeFileSync(
      authFile,
      JSON.stringify({
        v: 1,
        signingKey: privateKey.export({ format: 'jwk' }),
        devices: [
          {
            name: 'Test desktop',
            hostPublicKeyB64,
            accessKeySha256: createHash('sha256').update(accessKey).digest('base64url')
          }
        ]
      }),
      { mode: 0o600 }
    )
    const request = (key = accessKey, host = hostPublicKeyB64) => ({
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ relayHostId, hostPublicKeyB64: host })
    })
    return { directory, keyPair, hostPublicKeyB64, relayHostId, accessKey, authFile, request }
  }

  it('binds short-lived tokens to an enrolled desktop and publishes only its public signing key', async () => {
    const f = fixture()
    const issuer = 'https://relay.example.test'
    const auth = loadSelfHostedRelayAuth(f.authFile, issuer)
    const app = new Hono()
    auth.register(app)
    expect((await app.request('/v1/self-hosted/token', f.request('a'.repeat(43)))).status).toBe(401)
    const otherHost = Buffer.from(nacl.box.keyPair().publicKey).toString('base64')
    expect(
      (await app.request('/v1/self-hosted/token', f.request(f.accessKey, otherHost))).status
    ).toBe(403)
    const response = await app.request('/v1/self-hosted/token', f.request())
    expect(response.headers.get('cache-control')).toBe('no-store')
    const token = TokenResponse.parse(await response.json())
    const verified = await jwtVerify(token.relayToken, auth.keys, {
      issuer,
      audience: 'orca-relay'
    })
    expect(verified.payload).toMatchObject({
      sub: 'self-hosted',
      prof: f.relayHostId,
      org: issuer,
      relayHostId: f.relayHostId,
      purpose: 'host-control'
    })
    expect(token.expiresAt - Date.now()).toBeLessThanOrEqual(RELAY_PROTOCOL_LIMITS.relayTokenTtlMs)
    await expect(
      jwtVerify(token.relayToken, auth.keys, {
        issuer,
        audience: 'orca-relay',
        currentDate: new Date(token.expiresAt + 1)
      })
    ).rejects.toThrow()
    const jwks = JSON.stringify(await (await app.request('/.well-known/jwks.json')).json())
    expect(jwks).not.toContain('"d":')
    expect(jwks).not.toContain(f.accessKey)
    expect(jwks).not.toContain('accessKeySha256')
    for (let i = 1; i < 30; i++) {
      expect((await app.request('/v1/self-hosted/token', f.request())).status).toBe(200)
    }
    expect((await app.request('/v1/self-hosted/token', f.request())).status).toBe(429)
  })

  it('keeps one client at its connection limit from blocking other clients behind the private proxy', async () => {
    const f = fixture()
    const config = loadRelayConfig({
      ORCA_RELAY_PUBLIC_URL: 'http://127.0.0.1',
      ORCA_RELAY_AUTH_MODE: 'self-hosted',
      ORCA_RELAY_SELF_HOSTED_AUTH_FILE: f.authFile,
      ORCA_RELAY_SELF_HOSTED_TRUST_PRIVATE_PROXY: 'true',
      ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: randomBytes(32).toString('base64url')
    })
    const database = await openInMemoryRelayDatabase()
    cleanup.push(() => database.close())
    const relay = createRelayServer(config, database)
    relay.server.listen(0, '127.0.0.1')
    await once(relay.server, 'listening')
    cleanup.push(() => new Promise<void>((resolve) => relay.server.close(() => resolve())))
    const address = relay.server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')
    const dial = (clientAddress: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/connect/${f.relayHostId}`, {
        headers: { 'x-forwarded-for': clientAddress }
      })
      cleanup.push(() => {
        socket.terminate()
      })
      return once(socket, 'open')
    }
    for (let i = 0; i < 4; i++) await dial('203.0.113.7')
    await expect(dial('203.0.113.7')).rejects.toThrow('429')
    await expect(dial('198.51.100.2')).resolves.toBeDefined()
  })

  it('runs assignment, host proof, phone pairing and resume after a server restart without cloud auth', async () => {
    const f = fixture()
    const portProbe = createServer()
    portProbe.listen(0, '127.0.0.1')
    await once(portProbe, 'listening')
    const address = portProbe.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')
    await new Promise<void>((resolve) => portProbe.close(() => resolve()))
    const origin = `http://127.0.0.1:${address.port}`
    const config = loadRelayConfig({
      PORT: String(address.port),
      ORCA_RELAY_PUBLIC_URL: origin,
      ORCA_RELAY_AUTH_MODE: 'self-hosted',
      ORCA_RELAY_SELF_HOSTED_AUTH_FILE: f.authFile,
      ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: randomBytes(32).toString('base64url'),
      ORCA_RELAY_DATA_DIR: join(f.directory, 'state')
    })
    const nativeFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (new URL(url).origin !== origin) throw new Error('Unexpected external dependency')
      return nativeFetch(input, init)
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const openServer = async () => {
      const database = await openRelayDatabase({ dataDir: config.dataDir })
      await reconcileCellAdmissionAtStartup(config, new RelayAssignmentStore(database))
      const relay = createRelayServer(config, database)
      relay.server.listen(config.port, '127.0.0.1')
      await once(relay.server, 'listening')
      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        relay.sessions.drain(0)
        await new Promise<void>((resolve) => relay.server.close(() => resolve()))
        await database.close()
      }
      cleanup.push(stop)
      return { relay, stop }
    }
    const openSocket = async (path: string, headers?: Record<string, string>) => {
      const socket = new WebSocket(`${origin.replace('http:', 'ws:')}${path}`, {
        headers,
        perMessageDeflate: false
      })
      cleanup.push(() => {
        socket.terminate()
      })
      await once(socket, 'open')
      return socket
    }
    const openHost = async () => {
      const token = TokenResponse.parse(
        await (await fetch(`${origin}/v1/self-hosted/token`, f.request())).json()
      )
      const authorization = `Bearer ${token.relayToken}`
      const assignment = AssignmentResponse.parse(
        await (
          await fetch(`${origin}/v1/assign`, {
            method: 'POST',
            headers: { authorization, 'content-type': 'application/json' },
            body: JSON.stringify({ v: 1, relayHostId: f.relayHostId })
          })
        ).json()
      )
      expect(assignment.cellUrl).toBe(origin)
      const host = await openSocket('/v1/host/control', { authorization })
      const challengePromise = nextFrame(host, 'host-challenge')
      host.send(
        JSON.stringify({
          type: 'host-hello',
          v: 1,
          relayHostId: f.relayHostId,
          assignmentEpoch: assignment.assignmentEpoch,
          hostPublicKeyB64: f.hostPublicKeyB64,
          appVersion: 'test'
        })
      )
      const challenge = await challengePromise
      const plaintext = nacl.box.open(
        Buffer.from(String(challenge.ciphertextB64), 'base64'),
        Buffer.from(String(challenge.nonceB64), 'base64'),
        Buffer.from(String(challenge.relayEphemeralPublicKeyB64), 'base64'),
        f.keyPair.secretKey
      )
      if (!plaintext) throw new Error('Challenge did not decrypt')
      const domain = Buffer.from(`${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`)
      expect(Buffer.from(plaintext.subarray(0, domain.length))).toEqual(domain)
      const size = Buffer.from(plaintext).readUInt32BE(domain.length)
      const start = domain.length + 4
      const proofB64 = createHmac('sha256', plaintext.subarray(start + size))
        .update(buildHostProofMacInput(plaintext.subarray(start, start + size)))
        .digest('base64')
      const ack = nextFrame(host, 'host-hello-ack')
      host.send(
        JSON.stringify({ type: 'host-challenge-ack', challengeId: challenge.challengeId, proofB64 })
      )
      return { host, ack: await ack }
    }
    const attachPhone = async (host: WebSocket, generation: unknown, credential: string) => {
      const phone = await openSocket(`/v1/connect/${f.relayHostId}`)
      const connection = nextFrame(host, 'conn-open')
      phone.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential }))
      const opened = await connection
      const data = await openSocket(`/v1/host/data/${String(opened.connId)}`)
      const hello = nextFrame(phone, 'relay-hello')
      data.send(
        JSON.stringify({ type: 'host-data-auth', v: 1, connTicket: opened.connTicket, generation })
      )
      return { phone, data, opened, hello: await hello }
    }

    const first = await openServer()
    expect((await fetch(`${origin}/ready`)).status).toBe(200)
    expect((await fetch(`${origin}/v1/admin/drain`, { method: 'POST' })).status).toBe(404)
    const { host, ack } = await openHost()
    const inviteResult = nextFrame(host, 'invite-created')
    host.send(
      JSON.stringify({ type: 'invite-create', reqId: 'pair-once', relayDeviceId: 'phone-1' })
    )
    const invite = await inviteResult
    const paired = await attachPhone(host, ack.generation, String(invite.inviteToken))
    expect(paired.hello).toMatchObject({ ok: true, credentialKind: 'invite' })
    const resumeToken = randomBytes(32).toString('base64url')
    const installed = nextFrame(host, 'device-credential-installed')
    host.send(
      JSON.stringify({
        type: 'device-credential-install',
        v: 1,
        reqId: 'install-1',
        relayDeviceId: 'phone-1',
        newResumeTokenHash: createHash('sha256').update(resumeToken).digest('base64url'),
        authorization: { mode: 'relay-basis', basisConnId: paired.opened.connId }
      })
    )
    expect(await installed).toMatchObject({ currentVersion: 1 })
    paired.phone.terminate()
    paired.data.terminate()
    host.terminate()
    await first.stop()

    await openServer()
    const resumedHost = await openHost()
    const resumed = await attachPhone(resumedHost.host, resumedHost.ack.generation, resumeToken)
    expect(resumed.hello).toMatchObject({
      ok: true,
      credentialKind: 'resume',
      acceptedAs: 'current'
    })
    const forwarded = once(resumed.data, 'message')
    resumed.phone.send(Buffer.from('opaque-end-to-end-encrypted-payload'))
    expect(String((await forwarded)[0])).toBe('opaque-end-to-end-encrypted-payload')
    const confirmed = nextFrame(resumedHost.host, 'device-resume-confirmed')
    resumedHost.host.send(
      JSON.stringify({
        type: 'device-resume-confirm',
        v: 1,
        reqId: 'confirm-1',
        basisConnId: resumed.opened.connId
      })
    )
    expect(await confirmed).toMatchObject({ renewed: true, acceptedAs: 'current' })
    expect(fetchSpy.mock.calls.every(([url]) => String(url).startsWith(origin))).toBe(true)
  })
})
