import type { OpenFile } from '@/store/slices/editor'
import type { EditorBufferViewIndex } from '@/store/slices/editor/buffers/editor-buffer-views'
import {
  EDITOR_BUFFER_ROUTE_INPUT_KEYS,
  type EditorBufferRouteState
} from '@/store/slices/editor/buffers/editor-buffer-identity-cache'
import { getEditorModelOwnerKey } from './editor-model-owner'

type OwnerKeyState = EditorBufferRouteState & Partial<EditorBufferViewIndex>

function ownerInputsEqual(a: OwnerKeyState, b: OwnerKeyState): boolean {
  return (
    a.editorBufferIdOf === b.editorBufferIdOf &&
    EDITOR_BUFFER_ROUTE_INPUT_KEYS.every((key) => a[key] === b[key])
  )
}

function cachedOwnerKey(
  keys: WeakMap<OpenFile, string>,
  file: OpenFile,
  state: OwnerKeyState
): string {
  let key = keys.get(file)
  if (key === undefined) {
    key = getEditorModelOwnerKey(file, state)
    keys.set(file, key)
  }
  return key
}

/** Keys stay valid until an owner input changes, so a tab edit re-resolves that tab, not every tab. */
export function createEditorModelOwnerKeyCache(initialState: OwnerKeyState) {
  let keyState = initialState
  let keys = new WeakMap<OpenFile, string>()
  const ownerKeyOf = (file: OpenFile, state: OwnerKeyState): string => {
    if (state !== keyState) {
      if (!ownerInputsEqual(state, keyState)) {
        keys = new WeakMap()
      }
      keyState = state
    }
    return cachedOwnerKey(keys, file, state)
  }
  /** Resolver for `state` that never evicts the current keys, for reading a superseded state. */
  const ownerKeyReaderFor = (state: OwnerKeyState): ((file: OpenFile) => string) => {
    const stateKeys = ownerInputsEqual(state, keyState) ? keys : new WeakMap<OpenFile, string>()
    return (file) => cachedOwnerKey(stateKeys, file, state)
  }
  return { ownerKeyOf, ownerKeyReaderFor, ownerInputsEqual }
}
