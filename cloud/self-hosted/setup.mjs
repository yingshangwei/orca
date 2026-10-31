import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export function createSelfHostedConfiguration({
  url,
  hostPublicKey,
  deviceName = 'Desktop',
  output
}) {
  const origin = new URL(url)
  if (
    origin.protocol !== 'https:' ||
    origin.port ||
    origin.origin !== url ||
    origin.pathname !== '/'
  ) {
    throw new Error(
      'URL must be an HTTPS origin on port 443 without a path, credentials, query or trailing slash'
    )
  }
  const publicKey = Buffer.from(hostPublicKey, 'base64')
  if (publicKey.length !== 32 || publicKey.toString('base64') !== hostPublicKey) {
    throw new Error('Host public key must be the 32-byte base64 key copied from Orca')
  }
  if (!deviceName.trim() || deviceName.length > 128) throw new Error('Invalid device name')
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const accessKey = randomBytes(32).toString('base64url')
  const signingKey = randomBytes(32).toString('base64url')
  const auth = {
    v: 1,
    signingKey: privateKey.export({ format: 'jwk' }),
    devices: [
      {
        name: deviceName,
        accessKeySha256: createHash('sha256').update(accessKey).digest('base64url'),
        hostPublicKeyB64: hostPublicKey
      }
    ]
  }
  // Exclusive creation preserves the keys and existing phone pairings on accidental reruns.
  mkdirSync(output, { mode: 0o700 })
  const write = (name, content) =>
    writeFileSync(resolve(output, name), content, { flag: 'wx', mode: 0o600 })
  write('auth.json', `${JSON.stringify(auth, null, 2)}\n`)
  write('public.env', `ORCA_RELAY_PUBLIC_URL=${url}\n`)
  write(
    'relay.env',
    [
      'ORCA_RELAY_AUTH_MODE=self-hosted',
      'ORCA_RELAY_ROLE=combined',
      'ORCA_RELAY_SELF_HOSTED_TRUST_PRIVATE_PROXY=true',
      'ORCA_RELAY_SELF_HOSTED_AUTH_FILE=/data/auth.json',
      'ORCA_RELAY_DATA_DIR=/data/state',
      `ORCA_RELAY_ASSIGNMENT_SIGNING_KEY=${signingKey}`,
      ''
    ].join('\n')
  )
  write(
    'desktop-credentials.txt',
    `Relay URL: ${url}\nAccess key: ${accessKey}\nHost public key: ${hostPublicKey}\n`
  )
  return { output: resolve(output), credentials: resolve(output, 'desktop-credentials.txt') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        url: { type: 'string' },
        'host-public-key': { type: 'string' },
        'device-name': { type: 'string', default: 'Desktop' },
        output: {
          type: 'string',
          default: resolve(dirname(fileURLToPath(import.meta.url)), 'generated')
        }
      }
    })
    if (!values.url || !values['host-public-key']) {
      throw new Error(
        'Usage: node setup.mjs --url https://relay.example.com --host-public-key BASE64 [--device-name NAME] [--output DIRECTORY]'
      )
    }
    const result = createSelfHostedConfiguration({
      url: values.url,
      hostPublicKey: values['host-public-key'],
      deviceName: values['device-name'],
      output: values.output
    })
    console.log(
      `Configuration created in ${result.output}. Read ${result.credentials} locally to configure the desktop.`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not create configuration')
    process.exitCode = 1
  }
}
