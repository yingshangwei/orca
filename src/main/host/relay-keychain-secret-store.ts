import { runProcessSync } from '@orca/process-host'
import { getSecretStore, type SecretStore } from '../../shared/secret-store'
import { openOrcadSecret, sealOrcadSecret } from '../orcad/orcad-secret-sealing'

const MAGIC = Buffer.from('orca-relay-keychain:v1\0')
const UNAVAILABLE = 'The relay keychain is unavailable. Saved credentials remain protected.'

class RelayKeychainSecretStore implements SecretStore {
  constructor(
    private readonly helperPath: string,
    private readonly legacy: () => SecretStore
  ) {}

  isEncryptionAvailable(): boolean {
    try {
      this.run('status')
      return true
    } catch {
      return false
    }
  }

  encryptString(plainText: string): Buffer {
    const key = this.readKey('get-or-create')
    try {
      return Buffer.concat([MAGIC, sealOrcadSecret(key, plainText)])
    } finally {
      key.fill(0)
    }
  }

  decryptString(cipher: Buffer): string {
    if (!cipher.subarray(0, MAGIC.length).equals(MAGIC)) {
      return this.legacy().decryptString(cipher)
    }
    const key = this.readKey('read')
    try {
      return openOrcadSecret(key, cipher.subarray(MAGIC.length))
    } finally {
      key.fill(0)
    }
  }

  describeProtectionGap(): string | null {
    return this.isEncryptionAvailable() ? null : UNAVAILABLE
  }

  plaintextFallbackRefusal(): string {
    return UNAVAILABLE
  }

  private readKey(command: 'read' | 'get-or-create'): Buffer {
    const key = this.run(command)
    if (key.length !== 32) {
      key.fill(0)
      throw new Error('relay_keychain_invalid_key')
    }
    return key
  }

  private run(command: 'status' | 'read' | 'get-or-create'): Buffer {
    const result = runProcessSync({
      program: this.helperPath,
      args: [command],
      captureStdoutAsBytes: true,
      maxOutputBytes: 1024,
      timeoutMs: 2000
    })
    if (result.code !== 0 || result.timedOut || result.signal || !result.stdoutBytes) {
      result.stdoutBytes?.fill(0)
      throw new Error('relay_keychain_unavailable')
    }
    return result.stdoutBytes
  }
}

export function createRelaySecretStore(options: {
  helperPath: string
  platform?: NodeJS.Platform
  legacy?: () => SecretStore
}): SecretStore {
  const legacy = options.legacy ?? getSecretStore
  return (options.platform ?? process.platform) === 'darwin'
    ? new RelayKeychainSecretStore(options.helperPath, legacy)
    : legacy()
}
