import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectSignTargets,
  isExpectedRequirement,
  isWithin,
  localDesignatedRequirement,
  localSigningPaths,
  parseCodesignDetails,
  parseKeychainSearchList,
  quoteSecurityArgument,
  searchListWithout,
  signApp
} from './mac-local-signing.mjs'

const MACH_O_64 = Buffer.from('cffaedfe0c000001', 'hex')
const FAT = Buffer.from('cafebabe00000002', 'hex')
const JAVA_CLASS = Buffer.from('cafebabe00000034', 'hex')
const SHA1 = '0123456789ABCDEF0123456789ABCDEF01234567'
const OLD_A = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const OLD_B = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'

let root = ''

function file(relativePath, bytes) {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-local-signing-test-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('collectSignTargets', () => {
  it('signs innermost code first, the terminal host included, and skips data and excluded payloads', () => {
    const app = join(root, 'Orca.app')
    file('Orca.app/Contents/MacOS/Orca', MACH_O_64)
    file('Orca.app/Contents/MacOS/orca-relay-keychain', FAT)
    file('Orca.app/Contents/Frameworks/E.framework/Versions/A/E', FAT)
    symlinkSync('A', join(app, 'Contents/Frameworks/E.framework/Versions/Current'))
    file(
      'Orca.app/Contents/Helpers/Orca Terminal Host.app/Contents/MacOS/orca-terminal-host',
      MACH_O_64
    )
    file('Orca.app/Contents/Resources/orcad-template/darwin-arm64/node', MACH_O_64)
    file('Orca.app/Contents/Resources/vendor/Plugin.class', JAVA_CLASS)
    file('Orca.app/Contents/Resources/readme.txt', Buffer.from('not code'))

    const targets = collectSignTargets(app, ['/orcad-template/']).map((path) =>
      path.slice(app.length)
    )

    expect(targets.at(-1)).toBe('')
    expect(targets).toEqual(
      expect.arrayContaining([
        '/Contents/MacOS/orca-relay-keychain',
        '/Contents/Frameworks/E.framework/Versions/A/E',
        '/Contents/Frameworks/E.framework',
        '/Contents/Helpers/Orca Terminal Host.app/Contents/MacOS/orca-terminal-host',
        '/Contents/Helpers/Orca Terminal Host.app'
      ])
    )
    expect(targets).toHaveLength(6)
    expect(targets).not.toContain('/Contents/MacOS/Orca')
    const before = (inner, outer) => targets.indexOf(inner) < targets.indexOf(outer)
    expect(
      before('/Contents/Frameworks/E.framework/Versions/A/E', '/Contents/Frameworks/E.framework')
    ).toBe(true)
    expect(
      before(
        '/Contents/Helpers/Orca Terminal Host.app/Contents/MacOS/orca-terminal-host',
        '/Contents/Helpers/Orca Terminal Host.app'
      )
    ).toBe(true)
  })
})

describe('designated requirement', () => {
  const leaf = `certificate leaf = H"${SHA1.toLowerCase()}"`
  const id = 'identifier "com.stablyai.orca"'
  const compatible = `${id} and (${leaf} or cdhash H"${OLD_A}" or cdhash H"${OLD_B}")`

  it('pins the certificate, and adds only the exact legacy cdhashes it was given', () => {
    expect(localDesignatedRequirement(SHA1)).toBe(`${id} and ${leaf}`)
    expect(localDesignatedRequirement(SHA1, [OLD_A, OLD_B.toUpperCase(), OLD_A])).toBe(compatible)
    for (const bad of ['1234abcd', `${OLD_A}" or true or cdhash H"${OLD_B}`]) {
      expect(() => localDesignatedRequirement(SHA1, [bad])).toThrow('40 hex')
    }
    expect(() => localDesignatedRequirement('not-a-sha1')).toThrow('40 hex')
  })

  it('accepts exactly what it would write, whatever the hex case', () => {
    const upperHex = (text) => text.replace(/H"(\w+)"/g, (_, hex) => `H"${hex.toUpperCase()}"`)
    expect(isExpectedRequirement(upperHex(`${id} and ${leaf}`), SHA1)).toBe(true)
    expect(isExpectedRequirement(upperHex(compatible), SHA1, [OLD_A, OLD_B])).toBe(true)
  })

  it.each([
    ['identifier alone', id, []],
    ['an ad-hoc cdhash', `cdhash H"${OLD_B}"`, []],
    ['a tautology beside the certificate', `${id} or true or ${leaf}`, []],
    ['an always-true alternative', `${id} and (${leaf} or cdhash H"${OLD_A}" or always)`, [OLD_A]],
    ['a cdhash nobody verified', compatible, [OLD_A]],
    ['a missing legacy cdhash', `${id} and (${leaf} or cdhash H"${OLD_A}")`, [OLD_A, OLD_B]],
    ['legacy hashes without the identifier', `${leaf} or cdhash H"${OLD_A}"`, [OLD_A]],
    ['another certificate', `${id} and certificate leaf = H"${'f'.repeat(40)}"`, []],
    ['any trusted certificate', `${id} and anchor trusted`, []],
    ['another identifier', `identifier "com.example.other" and ${leaf}`, []]
  ])('rejects %s', (_, requirement, legacy) => {
    expect(isExpectedRequirement(requirement, SHA1, legacy)).toBe(false)
  })
})

describe('signing target and inputs', () => {
  it('treats only real descendants as inside a directory', () => {
    expect(isWithin('/Applications/Orca.app', '/Applications')).toBe(true)
    expect(isWithin('/Applications', '/Applications')).toBe(true)
    expect(isWithin('/Applications2/Orca.app', '/Applications')).toBe(false)
  })

  it.skipIf(process.platform !== 'darwin' || !existsSync('/Applications/Safari.app'))(
    'refuses an installed app reached through a symlinked parent, before touching any keychain',
    () => {
      symlinkSync('/Applications', join(root, 'apps'))
      expect(() =>
        signApp(join(root, 'apps', 'Safari.app'), { paths: localSigningPaths(join(root, 'none')) })
      ).toThrow('refusing to re-sign an app inside ')
    }
  )

  it('reads identifier and cdhash from codesign -d output', () => {
    const output = [
      'Executable=/tmp/Orca.app/Contents/MacOS/Orca',
      'Identifier=com.stablyai.orca',
      'CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+7 location=embedded',
      'CandidateCDHash sha256=aaaa',
      `CDHash=${OLD_A}`,
      'Signature=adhoc'
    ].join('\n')
    expect(parseCodesignDetails(output)).toMatchObject({
      Identifier: 'com.stablyai.orca',
      CDHash: OLD_A,
      Signature: 'adhoc'
    })
  })
})

describe('keychain search list restore', () => {
  const login = '/Users/u/Library/Keychains/login.keychain-db'
  const signing = '/Users/u/Library/Application Support/Orca Local Signing/orca.keychain-db'

  it('removes only the signing keychain, keeping entries others changed meanwhile', () => {
    const concurrent = '/Users/u/Library/Keychains/other-task.keychain-db'
    expect(searchListWithout([login, signing, concurrent], signing)).toEqual([login, concurrent])
    expect(searchListWithout([concurrent, login], signing)).toEqual([concurrent, login])
  })

  it('matches the keychain by its real path', () => {
    const canonical = (path) => path.replace(/^\/private\/var\//, '/var/')
    expect(
      searchListWithout([login, '/private/var/k/x.keychain-db'], '/var/k/x.keychain-db', canonical)
    ).toEqual([login])
  })
})

describe('security(1) argument handling', () => {
  it('reads the search list security prints', () => {
    const output =
      '    "/Users/u/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n'
    expect(parseKeychainSearchList(output)).toEqual([
      '/Users/u/Library/Keychains/login.keychain-db',
      '/Library/Keychains/System.keychain'
    ])
  })

  it('refuses values that could split or extend an interactive command', () => {
    expect(quoteSecurityArgument('/Users/u/Library/Application Support/x.keychain-db')).toBe(
      '"/Users/u/Library/Application Support/x.keychain-db"'
    )
    for (const value of ['a"b', 'a\\b', 'a\nunlock-keychain']) {
      expect(() => quoteSecurityArgument(value)).toThrow('refusing')
    }
  })
})
