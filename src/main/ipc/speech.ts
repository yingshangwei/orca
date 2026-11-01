import { ipcMain, BrowserWindow, systemPreferences } from 'electron'
import { abortWhenRendererGone } from './renderer-lifetime-abort'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { SPEECH_MODEL_CATALOG } from '../speech/model-catalog'
import { deleteLocalSpeechModel } from '../speech/speech-model-deletion'
import { getSpeechModelManager, getSpeechSttService } from '../speech/speech-runtime-service'
import {
  clearOpenAiSpeechApiKey,
  getOpenAiSpeechApiKeyProtection,
  hasOpenAiSpeechApiKey,
  saveOpenAiSpeechApiKey
} from '../speech/openai-api-key-store'
import type { Store } from '../persistence'

export function registerSpeechHandlers(store: Store): void {
  ipcMain.handle('speech:getCatalog', () => {
    return SPEECH_MODEL_CATALOG
  })

  ipcMain.handle('speech:getModelStates', async () => {
    return getSpeechModelManager(store).getModelStates()
  })

  ipcMain.handle('speech:getOpenAiApiKeyStatus', async () => {
    return { configured: hasOpenAiSpeechApiKey(), protection: getOpenAiSpeechApiKeyProtection() }
  })

  ipcMain.handle('speech:saveOpenAiApiKey', async (_event, apiKey: string) => {
    saveOpenAiSpeechApiKey(apiKey)
    return { configured: true, protection: getOpenAiSpeechApiKeyProtection() }
  })

  ipcMain.handle('speech:clearOpenAiApiKey', async () => {
    clearOpenAiSpeechApiKey()
    return { configured: false, protection: null }
  })

  ipcMain.handle('speech:downloadModel', async (event, modelId: string) => {
    const manager = getSpeechModelManager(store)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return
    }
    const clearProgressCallback = manager.setProgressCallback((id, progress) => {
      if (!window.isDestroyed()) {
        window.webContents.send('speech:downloadProgress', { modelId: id, progress })
      }
    })
    // Why: ModelManager is process-wide; scope this BrowserWindow closure to
    // the download/window lifetime so stale windows are not retained.
    let progressCallbackCleared = false
    const cleanupProgressCallback = (): void => {
      if (progressCallbackCleared) {
        return
      }
      progressCallbackCleared = true
      window.off('closed', cleanupProgressCallback)
      clearProgressCallback()
    }
    window.once('closed', cleanupProgressCallback)
    try {
      await manager.downloadModel(modelId)
    } finally {
      cleanupProgressCallback()
    }
  })

  ipcMain.handle('speech:cancelDownload', async (_event, modelId: string) => {
    getSpeechModelManager(store).cancelDownload(modelId)
  })

  ipcMain.handle('speech:deleteModel', async (_event, modelId: string) => {
    await deleteLocalSpeechModel({
      store,
      modelManager: getSpeechModelManager(store),
      sttService: getSpeechSttService(store),
      modelId
    })
  })

  const getHotwordsFilePath = (content: string): string => {
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 12)
    // Why: sherpa-onnx cannot read non-ASCII Windows paths, so co-locate the
    // hotwords file with the ASCII-safe model cache instead of userData.
    return join(getSpeechModelManager(store).getModelsDir(), `speech-hotwords-${digest}.txt`)
  }

  const hotwordFileUsers = new Map<string, { users: number; written: boolean }>()
  const retainHotwordsFile = (path: string): ((written: boolean) => void) => {
    const entry = hotwordFileUsers.get(path) ?? { users: 0, written: false }
    entry.users += 1
    hotwordFileUsers.set(path, entry)
    return (written) => {
      entry.written ||= written
      entry.users -= 1
      if (entry.users === 0) {
        hotwordFileUsers.delete(path)
        if (entry.written) {
          unlink(path).catch(() => {})
        }
      }
    }
  }

  // Renderer run ids restart per document; a retired document's owner must not be reused by its successor.
  const retiredDocumentCounts = new Map<number, number>()
  const getDesktopOwner = (senderId: number, sessionId: string): string =>
    `desktop:${senderId}:${retiredDocumentCounts.get(senderId) ?? 0}:${sessionId}`

  const dictationListeners = new Map<number, { owner: string; cleanup: () => void }>()

  ipcMain.handle(
    'speech:startDictation',
    async (event, modelId: string, hotwords?: string[], sessionId = 'desktop') => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        return
      }
      let resolvedHotwordsPath: string | undefined
      let releaseHotwords: ((written: boolean) => void) | undefined
      let rendererRetired = false
      const rendererLifetime = abortWhenRendererGone(event.sender)
      const senderId = event.sender.id
      const owner = getDesktopOwner(senderId, sessionId)
      let sessionListenerRemoved = false
      let sessionReady = false
      const cleanupOnRendererGone = (): void => {
        if (!rendererRetired && getDesktopOwner(senderId, sessionId) === owner) {
          retiredDocumentCounts.set(senderId, (retiredDocumentCounts.get(senderId) ?? 0) + 1)
        }
        rendererRetired = true
        cleanupSessionListener()
        void getSpeechSttService(store)
          .stopDictation(owner, { discard: true })
          .catch(() => {})
      }
      const cleanupSessionListener = (): void => {
        sessionListenerRemoved = true
        window.off('closed', cleanupOnRendererGone)
        rendererLifetime.dispose()
        if (dictationListeners.get(senderId)?.cleanup === cleanupSessionListener) {
          dictationListeners.delete(senderId)
        }
      }
      window.once('closed', cleanupOnRendererGone)
      rendererLifetime.signal.addEventListener('abort', cleanupOnRendererGone, { once: true })

      try {
        // Why: on macOS, the Electron binary needs explicit TCC permission for
        // the microphone. Without it, getUserMedia succeeds but returns a silent
        // stream (all zeros). Check status and attempt to trigger the system
        // permission prompt if not yet granted.
        if (process.platform === 'darwin') {
          const micStatus = systemPreferences.getMediaAccessStatus('microphone')
          if (micStatus !== 'granted') {
            await systemPreferences.askForMediaAccess('microphone')
            const newStatus = systemPreferences.getMediaAccessStatus('microphone')
            if (newStatus !== 'granted') {
              throw new Error(
                'Microphone access not granted. In System Settings > Privacy & Security > Microphone, ' +
                  'click "+" and add the Electron app, then restart Orca.'
              )
            }
          }
        }

        if (hotwords && hotwords.length > 0) {
          const content = `${hotwords.map((w) => `${w} :2.0`).join('\n')}\n`
          const hotwordsFilePath = getHotwordsFilePath(content)
          releaseHotwords = retainHotwordsFile(hotwordsFilePath)
          await writeFile(hotwordsFilePath, content, 'utf-8')
          resolvedHotwordsPath = hotwordsFilePath
        }

        if (rendererRetired || window.isDestroyed()) {
          cleanupSessionListener()
          return
        }

        await getSpeechSttService(store).startDictation(
          modelId,
          (msg) => {
            if (msg.type === 'ready') {
              sessionReady = true
            }
            if (rendererRetired || window.isDestroyed()) {
              return
            }
            switch (msg.type) {
              case 'ready':
                window.webContents.send('speech:ready', { sessionId })
                break
              case 'partial':
                window.webContents.send('speech:partial', { text: msg.text ?? '', sessionId })
                break
              case 'final':
                window.webContents.send('speech:final', { text: msg.text ?? '', sessionId })
                break
              case 'stopped':
                cleanupSessionListener()
                window.webContents.send('speech:stopped', { sessionId })
                break
              case 'error':
                window.webContents.send('speech:error', { error: msg.error ?? '', sessionId })
                void getSpeechSttService(store)
                  .stopDictation(owner)
                  .catch(() => undefined)
                  .finally(cleanupSessionListener)
                break
            }
          },
          resolvedHotwordsPath,
          owner
        )
        // Coalesced starts install no sink; only an accepted start supersedes the close hook.
        if (sessionReady) {
          dictationListeners.get(senderId)?.cleanup()
          if (!sessionListenerRemoved) {
            dictationListeners.set(senderId, { owner, cleanup: cleanupSessionListener })
          }
        } else {
          cleanupSessionListener()
        }
      } catch (err) {
        cleanupSessionListener()
        throw err
      } finally {
        releaseHotwords?.(resolvedHotwordsPath !== undefined)
      }
    }
  )

  ipcMain.handle(
    'speech:feedAudio',
    async (_event, buffer: Buffer, sampleRate: number, sessionId = 'desktop') => {
      // Why: the preload sends audio as a Buffer to avoid Float32Array data
      // being zeroed out during contextBridge + IPC serialization.
      const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
      getSpeechSttService(store).feedAudio(
        samples,
        sampleRate,
        getDesktopOwner(_event.sender.id, sessionId)
      )
    }
  )

  ipcMain.handle('speech:stopDictation', async (_event, sessionId = 'desktop') => {
    const owner = getDesktopOwner(_event.sender.id, sessionId)
    const listener = dictationListeners.get(_event.sender.id)
    await getSpeechSttService(store).stopDictation(owner)
    if (listener?.owner === owner) {
      listener.cleanup()
    }
  })
}
