// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMonacoColorizedLines } from './MonacoCodeExcerpt'

const mocks = vi.hoisted(() => {
  let releaseTokenizer: () => void = () => {}
  const tokenizerReady = new Promise<void>((resolve) => {
    releaseTokenizer = resolve
  })
  return { colorize: vi.fn(), tokenizerReady, releaseTokenizer }
})

vi.mock('@/lib/monaco-setup', () => ({
  monaco: {
    editor: { colorize: mocks.colorize, setTheme: vi.fn() },
    languages: {
      getLanguages: () => [],
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      setMonarchTokensProvider: vi.fn()
    }
  }
}))
vi.mock('monaco-editor/esm/vs/basic-languages/python/python.js', async () => {
  await mocks.tokenizerReady
  return { conf: {}, language: {} }
})
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))
vi.mock('@/store', () => ({ useAppStore: vi.fn() }))

function Probe({ lines, language = 'plaintext' }: { lines: string[]; language?: string }) {
  return <div>{useMonacoColorizedLines(lines, language).join('|')}</div>
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mocks.colorize.mockReset().mockResolvedValue('first<br/>second')
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('reuses colorized output for equal content in a fresh lines array', async () => {
  await act(async () => root.render(<Probe lines={['first', 'second']} />))
  expect(mocks.colorize).toHaveBeenCalledTimes(1)
  expect(container.textContent).toBe('first|second')

  await act(async () => root.render(<Probe lines={['first', 'second']} />))
  expect(mocks.colorize).toHaveBeenCalledTimes(1)

  await act(async () => root.render(<Probe lines={['changed', 'second']} />))
  expect(mocks.colorize).toHaveBeenCalledTimes(2)
})

it('skips abandoned colorization when the lazy tokenizer finishes after unmount', async () => {
  act(() => root.render(<Probe lines={['print(1)']} language="python" />))
  act(() => root.render(null))
  await act(async () => {
    mocks.releaseTokenizer()
    await vi.dynamicImportSettled()
  })
  expect(mocks.colorize).not.toHaveBeenCalled()
})
