import assert from 'node:assert/strict'
import { createHash, createPrivateKey, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSelfHostedConfiguration } from './setup.mjs'

test('generated configuration binds the desktop key and preserves secrets on rerun', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'orca-relay-setup-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const input = {
    url: 'https://relay.example.test',
    hostPublicKey: randomBytes(32).toString('base64'),
    output: join(parent, 'generated')
  }
  const result = createSelfHostedConfiguration(input)
  const authText = readFileSync(join(result.output, 'auth.json'), 'utf8')
  const auth = JSON.parse(authText)
  const credentials = readFileSync(result.credentials, 'utf8')
  const accessKey = credentials.match(/^Access key: ([A-Za-z0-9_-]{43})$/m)?.[1]
  assert.ok(accessKey)
  assert.equal(auth.devices[0].hostPublicKeyB64, input.hostPublicKey)
  assert.equal(
    auth.devices[0].accessKeySha256,
    createHash('sha256').update(accessKey).digest('base64url')
  )
  assert.equal(createPrivateKey({ key: auth.signingKey, format: 'jwk' }).asymmetricKeyType, 'ec')
  assert.ok(!authText.includes(accessKey))
  assert.throws(() => createSelfHostedConfiguration(input), { code: 'EEXIST' })
  assert.equal(readFileSync(result.credentials, 'utf8'), credentials)
  if (process.platform !== 'win32') {
    assert.equal(statSync(result.output).mode & 0o777, 0o700)
    assert.equal(statSync(result.credentials).mode & 0o777, 0o600)
    assert.equal(statSync(join(result.output, 'auth.json')).mode & 0o777, 0o600)
  }
})

test('rejects noncanonical or insecure URLs before creating files', () => {
  for (const url of [
    'http://relay.example.test',
    'https://user:password@relay.example.test',
    'https://relay.example.test/',
    'https://relay.example.test?x=1',
    'https://relay.example.test/path',
    'https://relay.example.test:8443'
  ]) {
    assert.throws(
      () =>
        createSelfHostedConfiguration({
          url,
          hostPublicKey: randomBytes(32).toString('base64'),
          output: '/unused'
        }),
      /HTTPS origin/
    )
  }
})
