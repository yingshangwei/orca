import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (process.platform === 'darwin') {
  const root = resolve(import.meta.dirname, '../..')
  const source = join(root, 'native/relay-keychain-macos/main.c')
  const output = join(root, 'native/relay-keychain-macos/.build/release/orca-relay-keychain')
  mkdirSync(dirname(output), { recursive: true })
  execFileSync(
    '/usr/bin/clang',
    [
      '-O2',
      '-Werror',
      '-Wno-deprecated-declarations',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      '-mmacosx-version-min=11.0',
      '-framework',
      'Security',
      '-framework',
      'CoreFoundation',
      source,
      '-o',
      output
    ],
    { stdio: 'inherit' }
  )
}
