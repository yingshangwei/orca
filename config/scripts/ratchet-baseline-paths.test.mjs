import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { listTrackedFiles, readTrackedSources } from './ratchet-baseline.mjs'

test('tracked-source ratchets read Unicode and newline filenames without Git quoting', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-ratchet-paths-'))
  try {
    execFileSync('git', ['init', '--quiet', directory])
    const names = ['src/普通.ts', 'src/line\nbreak.ts', 'src/with space.ts']
    mkdirSync(join(directory, 'src'))
    for (const [index, name] of names.entries()) {
      writeFileSync(join(directory, name), `source-${index}`)
    }
    writeFileSync(join(directory, 'src/untracked.ts'), 'must stay untracked')
    execFileSync('git', ['add', '--', ...names], { cwd: directory })
    assert.deepEqual(new Set(listTrackedFiles(directory, ['src'])), new Set(names))
    assert.deepEqual(
      readTrackedSources(directory, ['src']),
      new Map(names.map((name, index) => [name, `source-${index}`]))
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
