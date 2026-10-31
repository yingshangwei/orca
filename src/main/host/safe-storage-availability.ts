import { safeStorage } from 'electron'
import { SafeStorageWithheldError, safeStorageWithheldReason } from './keychain-withhold'

export {
  SafeStorageWithheldError,
  resetSafeStorageWithholdForTests,
  safeStoragePlaintextFallbackRefusal,
  safeStorageWithheldReason,
  withholdSafeStorage
} from './keychain-withhold'

/** `safeStorage` behind the run-wide withhold; use this, never `electron.safeStorage`. */
export const guardedSafeStorage = {
  isEncryptionAvailable(): boolean {
    return safeStorageWithheldReason() === null && safeStorage.isEncryptionAvailable()
  },
  encryptString(plainText: string): Buffer {
    const reason = safeStorageWithheldReason()
    if (reason !== null) {
      throw new SafeStorageWithheldError(reason)
    }
    return safeStorage.encryptString(plainText)
  },
  decryptString(cipher: Buffer): string {
    const reason = safeStorageWithheldReason()
    if (reason !== null) {
      throw new SafeStorageWithheldError(reason)
    }
    return safeStorage.decryptString(cipher)
  }
}
