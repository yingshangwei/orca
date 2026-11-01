import { app, BrowserWindow } from 'electron'
import { writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export class ExportTimeoutError extends Error {
  constructor(message = 'Export timed out') {
    super(message)
    this.name = 'ExportTimeoutError'
  }
}

const EXPORT_TIMEOUT_MS = 60_000

// Why: injected into the hidden export window so printToPDF does not fire while
// <img> elements are still fetching. printToPDF renders whatever is painted at
// the moment it runs; without this gate, remote images and Mermaid SVGs loaded
// via <img> can be missing from the output.
const WAIT_FOR_IMAGES_SCRIPT = `
new Promise((resolve) => {
  const imgs = Array.from(document.images || [])
  if (imgs.length === 0) { resolve(); return }
  let remaining = imgs.length
  const done = () => { remaining -= 1; if (remaining <= 0) resolve() }
  imgs.forEach((img) => {
    if (img.complete) { done(); return }
    img.addEventListener('load', done, { once: true })
    img.addEventListener('error', done, { once: true })
  })
})
`

export async function htmlToPdf(html: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  const tempDir = app.getPath('temp')
  const tempPath = path.join(tempDir, `orca-export-${randomUUID()}.html`)

  // Why: 'wx' is an exclusive create, so the shared temp dir cannot pre-seat this
  // path as a symlink and have the export write through it. EEXIST is the one
  // failure where the path is not ours, so it must not be unlinked below.
  try {
    await writeFile(tempPath, html, {
      encoding: 'utf-8',
      flag: 'wx',
      ...(signal ? { signal } : {})
    })
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw error
    }
    await removeOwnTempDocument(tempPath)
    throw error
  }

  try {
    signal?.throwIfAborted()
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Why: image-wait needs to run a short script inside the export page, and
        // the exported renderer DOM may already embed scripts/SVGs (e.g. Mermaid)
        // that need JS to paint correctly. The window stays sandboxed and
        // isolated so this is safe.
        javascript: true
      }
    })

    let timer: NodeJS.Timeout | undefined
    let removeAbortListener: (() => void) | undefined
    let removeLoadListeners: (() => void) | undefined

    try {
      const abortPromise = new Promise<never>((_resolve, reject) => {
        if (!signal) {
          return
        }
        const abort = (): void => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        removeAbortListener = () => signal.removeEventListener('abort', abort)
        if (signal.aborted) {
          abort()
        }
      })
      // Why: the timeout has to cover loading too. An export document whose script
      // never yields fires neither did-finish-load nor did-fail-load, so a
      // render-only timeout would leave this window and its temp file forever.
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ExportTimeoutError()), EXPORT_TIMEOUT_MS)
      })

      const loadAndPrint = (async (): Promise<Buffer> => {
        signal?.throwIfAborted()
        const loadPromise = new Promise<void>((resolve, reject) => {
          const finish = (): void => resolve()
          const fail = (
            _event: Electron.Event,
            errorCode: number,
            errorDescription: string
          ): void => {
            reject(new Error(`Failed to load export document: ${errorDescription} (${errorCode})`))
          }
          win.webContents.once('did-finish-load', finish)
          win.webContents.once('did-fail-load', fail)
          removeLoadListeners = () => {
            win.webContents.removeListener('did-finish-load', finish)
            win.webContents.removeListener('did-fail-load', fail)
          }
        })

        await Promise.all([win.loadFile(tempPath), loadPromise])
        signal?.throwIfAborted()
        await win.webContents.executeJavaScript(WAIT_FOR_IMAGES_SCRIPT, true)
        signal?.throwIfAborted()
        return win.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          margins: {
            top: 0.75,
            bottom: 0.75,
            left: 0.75,
            right: 0.75
          }
        })
      })()

      return await Promise.race([loadAndPrint, timeoutPromise, abortPromise])
    } finally {
      removeAbortListener?.()
      removeLoadListeners?.()
      if (timer) {
        clearTimeout(timer)
      }
      if (!win.isDestroyed()) {
        win.destroy()
      }
    }
  } finally {
    await removeOwnTempDocument(tempPath)
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

// unlink never follows a symlink, so this removes the entry this export created
// and never the target of one swapped in underneath it.
async function removeOwnTempDocument(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath)
  } catch {
    // Why: best-effort cleanup — losing the temp file should not surface
    // as a user-facing export failure.
  }
}
