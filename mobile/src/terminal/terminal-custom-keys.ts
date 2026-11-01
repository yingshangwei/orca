import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored, subscribeMirroredKey } from '../storage/mirrored-storage-keys'

const CUSTOM_ACCESSORY_KEYS_STORAGE_KEY = 'orca:custom-accessory-keys'

export type CustomKey = {
  id: string
  label: string
  bytes: string
  enter: boolean
}

function isCustomKey(value: unknown): value is CustomKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'label' in value &&
    typeof value.label === 'string' &&
    'bytes' in value &&
    typeof value.bytes === 'string' &&
    'enter' in value &&
    typeof value.enter === 'boolean'
  )
}

function parseStoredCustomKeys(raw: string | null): CustomKey[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isCustomKey) : []
  } catch {
    return []
  }
}

// Propagate read failures so writes cannot invent an empty baseline; malformed stored keys may be replaced.
async function readStoredCustomKeys(): Promise<CustomKey[]> {
  return parseStoredCustomKeys(await AsyncStorage.getItem(CUSTOM_ACCESSORY_KEYS_STORAGE_KEY))
}

// Accepted writes only; a read racing queued Settings writes can return an intermediate list.
export function subscribeStoredCustomKeys(listener: (keys: CustomKey[]) => void): () => void {
  return subscribeMirroredKey(CUSTOM_ACCESSORY_KEYS_STORAGE_KEY, (raw) =>
    listener(parseStoredCustomKeys(raw))
  )
}

export function loadCustomKeys(fallback: CustomKey[] = []): Promise<CustomKey[]> {
  return readStoredCustomKeys().catch(() => fallback)
}

function writeCustomKeys(keys: CustomKey[]): Promise<void> {
  // Through the one write path, which notes the mirror on an accepted write and on nothing else
  // (ruling 35). There is no rollback here any more because there is nothing to undo: on the page
  // a value over the cap rejects, and a rejected write never reached the map.
  return persistMirrored(CUSTOM_ACCESSORY_KEYS_STORAGE_KEY, JSON.stringify(keys))
}

// Every write to the stored list takes a turn here, so a settings save, an add and a removal never
// land over one that started first, and an add or removal reads what the last write saved.
let customKeysWriteTurn: Promise<unknown> = Promise.resolve()

function inCustomKeysWriteTurn<T>(write: () => Promise<T>): Promise<T> {
  const run = customKeysWriteTurn.then(write)
  customKeysWriteTurn = run.catch(() => {})
  return run
}

export function saveCustomKeys(keys: CustomKey[]): Promise<void> {
  return inCustomKeysWriteTurn(() => writeCustomKeys(keys))
}

export function updateStoredCustomKeys(
  change: (keys: CustomKey[]) => CustomKey[]
): Promise<CustomKey[]> {
  return inCustomKeysWriteTurn(async () => {
    const updated = change(await readStoredCustomKeys())
    await writeCustomKeys(updated)
    return updated
  })
}

// Like the modal's add: resolves with the stored list only once the store took it, so a refused write
// never drops a row from screen that the next load would bring back.
export function removeCustomKey(id: string): Promise<CustomKey[]> {
  return updateStoredCustomKeys((keys) => keys.filter((key) => key.id !== id))
}
