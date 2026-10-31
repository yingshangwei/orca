import { createHash, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createLocalJWKSet, SignJWT, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'
import { RELAY_PROTOCOL_LIMITS } from '@orca-cloud/relay-contract'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { RelayJWKSet } from './stale-if-error-jwks.js'
import { readBearer } from './relay-token-verifier.js'

const Base64Url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const HostPublicKey = z.string().refine((value) => {
  const decoded = Buffer.from(value, 'base64')
  return decoded.length === 32 && decoded.toString('base64') === value
})
const AuthFileSchema = z
  .object({
    v: z.literal(1),
    signingKey: z
      .object({
        kty: z.literal('EC'),
        crv: z.literal('P-256'),
        x: Base64Url32,
        y: Base64Url32,
        d: Base64Url32
      })
      .strict(),
    devices: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            accessKeySha256: Base64Url32,
            hostPublicKeyB64: HostPublicKey
          })
          .strict()
      )
      .min(1)
      .max(100)
  })
  .strict()
const TokenRequestSchema = z
  .object({
    relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    hostPublicKeyB64: HostPublicKey
  })
  .strict()

export function loadSelfHostedRelayAuth(path: string, issuer: string) {
  if (statSync(path).size > 128 * 1024) throw new Error('Self-hosted relay auth file is too large')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('Cannot read self-hosted relay auth file')
  }
  const parsed = AuthFileSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Invalid self-hosted relay auth file')
  const config = parsed.data
  const signingKey = createPrivateKey({ key: config.signingKey, format: 'jwk' })
  const publicKey = createPublicKey(signingKey).export({ format: 'jwk' })
  const kid = createHash('sha256').update(JSON.stringify(publicKey)).digest('base64url')
  const jwks = { keys: [{ ...publicKey, kid, alg: 'ES256', use: 'sig' }] }
  const lookup = createLocalJWKSet(jwks)
  const lookupKey: JWTVerifyGetKey = (header, token) => lookup(header, token)
  const keys: RelayJWKSet = Object.assign(lookupKey, {
    jwks: () => jwks,
    reload: async () => undefined
  })
  const devices = config.devices.map((device) => ({
    ...device,
    digest: Buffer.from(device.accessKeySha256, 'base64url'),
    relayHostId: createHash('sha256')
      .update(Buffer.from(device.hostPublicKeyB64, 'base64'))
      .digest('base64url')
      .slice(0, 16),
    windowStartedAt: 0,
    issuedInWindow: 0
  }))
  if (new Set(devices.map((device) => device.accessKeySha256)).size !== devices.length) {
    throw new Error('Self-hosted relay access keys must be unique')
  }

  function register(app: Hono): void {
    app.get('/.well-known/jwks.json', (context) => context.json(jwks))
    app.post('/v1/self-hosted/token', bodyLimit({ maxSize: 4096 }), async (context) => {
      context.header('Cache-Control', 'no-store')
      const accessKey = readBearer(context.req.header('authorization'))
      if (!accessKey || !/^[A-Za-z0-9_-]{43}$/.test(accessKey)) {
        return context.json({ error: 'invalid_credentials' }, 401)
      }
      const digest = createHash('sha256').update(accessKey).digest()
      const device = devices.find((candidate) => timingSafeEqual(candidate.digest, digest))
      if (!device) return context.json({ error: 'invalid_credentials' }, 401)
      const request = TokenRequestSchema.safeParse(await context.req.json().catch(() => null))
      if (!request.success) return context.json({ error: 'invalid_request' }, 400)
      if (
        request.data.hostPublicKeyB64 !== device.hostPublicKeyB64 ||
        request.data.relayHostId !== device.relayHostId
      ) {
        return context.json({ error: 'device_not_allowed' }, 403)
      }
      const now = Date.now()
      if (now - device.windowStartedAt >= 60_000) {
        device.windowStartedAt = now
        device.issuedInWindow = 0
      }
      if (device.issuedInWindow >= 30) {
        context.header('Retry-After', '60')
        return context.json({ error: 'rate_limited' }, 429)
      }
      device.issuedInWindow += 1
      const expiresAt = Math.floor(now / 1000) * 1000 + RELAY_PROTOCOL_LIMITS.relayTokenTtlMs
      const relayToken = await new SignJWT({
        prof: device.relayHostId,
        org: issuer,
        relayHostId: device.relayHostId,
        purpose: 'host-control'
      })
        .setProtectedHeader({ alg: 'ES256', kid })
        .setIssuer(issuer)
        .setAudience('orca-relay')
        .setSubject('self-hosted')
        .setIssuedAt(Math.floor(now / 1000))
        .setExpirationTime(expiresAt / 1000)
        .sign(signingKey)
      return context.json({ relayToken, expiresAt })
    })
  }

  return { keys, register }
}

export type SelfHostedRelayAuth = ReturnType<typeof loadSelfHostedRelayAuth>
