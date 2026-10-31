// A stable, self-signed code identity for local macOS builds. See docs/reference/macos-local-signing.md.
import { spawnSync } from 'node:child_process'
import { X509Certificate, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const require = createRequire(import.meta.url)
const SECURITY = '/usr/bin/security'
const CODESIGN = '/usr/bin/codesign'
// Why /usr/bin: a Homebrew OpenSSL 3 writes PKCS#12 ciphers older `security import` rejects.
const OPENSSL = '/usr/bin/openssl'
const CODE_SIGNING_EKU = '1.3.6.1.5.5.7.3.3'
const APP_IDENTIFIER = 'com.stablyai.orca'
const TERMINAL_HOST = join('Contents', 'Helpers', 'Orca Terminal Host.app')
// Why bounded: an unexpected keychain dialog must end the run, not wait for a click.
const CODESIGN_TIMEOUT_MS = 120_000
const MAX_LEGACY_APPS = 4
const BUNDLE_EXTENSIONS = ['.app', '.framework', '.xpc', '.appex', '.bundle']
const MACH_O_MAGICS = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'])

export function localSigningPaths(dir = process.env.ORCA_LOCAL_SIGNING_DIR) {
  const root = dir ?? join(homedir(), 'Library', 'Application Support', 'Orca Local Signing')
  return {
    root,
    keychain: join(root, 'orca-local-signing.keychain-db'),
    keychainPassword: join(root, 'keychain-password'),
    identity: join(root, 'identity.json')
  }
}

/** `security -i` splits on whitespace and honours double quotes only. */
export function quoteSecurityArgument(value) {
  if (/["\\\r\n]/.test(value)) {
    throw new Error(`refusing a security(1) argument with quotes, backslashes or newlines`)
  }
  return `"${value}"`
}

export function parseKeychainSearchList(output) {
  return [...output.matchAll(/^\s*"([^"]+)"\s*$/gm)].map((match) => match[1])
}

function canonicalPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** The search list with only `keychain` removed, so concurrent edits by others survive. */
export function searchListWithout(list, keychain, canonical = canonicalPath) {
  const target = canonical(keychain)
  return list.filter((entry) => canonical(entry) !== target)
}

/**
 * The designated requirement `sign` writes into the app and its terminal host.
 *
 * `legacyCdhashes` are exact hashes of earlier ad hoc builds (see `readLegacyCdhash`), so a
 * folder grant made to this build can also cover processes those builds still run.
 */
export function localDesignatedRequirement(sha1, legacyCdhashes = []) {
  if (!/^[0-9a-f]{40}$/i.test(sha1)) {
    throw new Error('certificate SHA-1 must be 40 hex digits')
  }
  for (const cdhash of legacyCdhashes) {
    if (!/^[0-9a-f]{40}$/i.test(cdhash)) {
      throw new Error(`legacy cdhash must be 40 hex digits: ${cdhash}`)
    }
  }
  const certificate = `certificate leaf = H"${sha1.toLowerCase()}"`
  const unique = [...new Set(legacyCdhashes.map((cdhash) => cdhash.toLowerCase()))]
  if (unique.length === 0) {
    return `identifier "${APP_IDENTIFIER}" and ${certificate}`
  }
  const alternatives = [certificate, ...unique.map((cdhash) => `cdhash H"${cdhash}"`)]
  return `identifier "${APP_IDENTIFIER}" and (${alternatives.join(' or ')})`
}

/**
 * True only for exactly the requirement `localDesignatedRequirement` builds from these inputs.
 * Why exact: a substring test would pass `identifier … or true or certificate leaf = …`.
 */
export function isExpectedRequirement(requirement, sha1, legacyCdhashes = []) {
  const normalized = requirement
    .trim()
    .replace(/H"([0-9a-fA-F]+)"/g, (_, hex) => `H"${hex.toLowerCase()}"`)
  return normalized === localDesignatedRequirement(sha1, legacyCdhashes)
}

/** `Key=value` lines from `codesign -d -vvv`. */
export function parseCodesignDetails(output) {
  const fields = {}
  for (const line of output.split('\n')) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line.trim())
    if (match && !(match[1] in fields)) {
      fields[match[1]] = match[2]
    }
  }
  return fields
}

/** True when `path` is `dir` or inside it, both already real paths. */
export function isWithin(path, dir) {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)
}

function isMachO(path) {
  const fd = openSync(path, 'r')
  try {
    const header = Buffer.alloc(8)
    if (readSync(fd, header, 0, 8, 0) < 8) {
      return false
    }
    const magic = header.subarray(0, 4).toString('hex')
    if (!MACH_O_MAGICS.has(magic)) {
      return false
    }
    // Why: Java class files share 0xcafebabe; a fat header's arch count is small, a class version is not.
    return magic !== 'cafebabe' || header.readUInt32BE(4) < 20
  } finally {
    closeSync(fd)
  }
}

/**
 * Every code object in the bundle, innermost first, so each seal covers already-signed content.
 * Symlinks are skipped: framework `Current` links resolve to a directory signed by its real path.
 */
export function collectSignTargets(appPath, ignorePatterns = []) {
  const ignores = ignorePatterns.map((pattern) => new RegExp(pattern))
  const targets = []
  const walk = (path, depth) => {
    if (ignores.some((pattern) => pattern.test(path))) {
      return
    }
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      return
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) {
        walk(join(path, name), depth + 1)
      }
      if (BUNDLE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
        targets.push({ path, depth })
      }
      return
    }
    // Signing the main executable also seals the app, before its sibling helpers are ready.
    if (path === join(appPath, 'Contents', 'MacOS', 'Orca')) {
      return
    }
    if (stat.isFile() && isMachO(path)) {
      targets.push({ path, depth })
    }
  }
  walk(appPath, 0)
  return targets.sort((a, b) => b.depth - a.depth).map((target) => target.path)
}

/** electron-builder's own exclusions, minus the terminal host, which must carry the app's identity. */
function signIgnorePatterns() {
  const { bundledRipgrepMacSignIgnore } = require('../bundled-ripgrep-resources.cjs')
  const { orcadTemplateMacSignIgnore } = require('./packaged-orcad-template.cjs')
  return [...bundledRipgrepMacSignIgnore, ...orcadTemplateMacSignIgnore]
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', ...options })
  if (result.error) {
    throw new Error(`${basename(program)} could not run: ${result.error.message}`)
  }
  return result
}

function runChecked(program, args, options = {}) {
  const result = run(program, args, options)
  if (result.status !== 0) {
    throw new Error(`${basename(program)} ${args[0]} failed: ${result.stderr.trim()}`)
  }
  return result
}

/** One `security -i` command per process, so its exit status is that command's. */
function securityWithSecret(command) {
  const result = run(SECURITY, ['-i'], { input: `${command}\n`, timeout: 30_000 })
  const verb = command.split(' ')[0]
  if (result.status !== 0 || /^security: /m.test(result.stderr) || result.signal) {
    throw new Error(`security ${verb} failed: ${result.stderr.replace(/-[kpP] \S+/g, '').trim()}`)
  }
}

/** Owner-only, owned by this user, and not a symlink someone could repoint. */
function assertPrivate(path, kind) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    throw new Error(`${path} is a symlink; expected the real ${kind}`)
  }
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`${path} is not a ${kind}`)
  }
  if (stat.uid !== process.getuid()) {
    throw new Error(`${path} is owned by another user`)
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${path} is readable by other users; expected owner-only permissions`)
  }
}

function readSigningState(paths) {
  if (!existsSync(paths.identity) || !existsSync(paths.keychainPassword)) {
    throw new Error(`no local signing identity at ${paths.root}; run "create" first`)
  }
  assertPrivate(paths.root, 'directory')
  for (const path of [paths.keychain, paths.keychainPassword, paths.identity]) {
    assertPrivate(path, 'file')
  }
  const identity = JSON.parse(readFileSync(paths.identity, 'utf8'))
  if (!/^[0-9A-F]{40}$/.test(identity.sha1 ?? '')) {
    throw new Error(`${paths.identity} has no certificate SHA-1`)
  }
  return { identity, password: readFileSync(paths.keychainPassword, 'utf8').trim() }
}

function userSearchList() {
  return parseKeychainSearchList(runChecked(SECURITY, ['list-keychains', '-d', 'user']).stdout)
}

function isInSearchList(keychain) {
  const list = userSearchList()
  // Why: an unread list would be restored as empty, dropping the login keychain.
  if (list.length === 0) {
    throw new Error('could not read the user keychain search list')
  }
  return searchListWithout(list, keychain).length !== list.length
}

/** Undo only this run's addition; entries others added or removed meanwhile stay as they are. */
function removeFromSearchList(keychain) {
  const list = userSearchList()
  const rest = searchListWithout(list, keychain)
  if (rest.length === list.length) {
    return
  }
  if (rest.length === 0) {
    throw new Error(`${keychain} is the only keychain in the search list; left it there`)
  }
  runChecked(SECURITY, ['list-keychains', '-d', 'user', '-s', ...rest])
}

export function createSigningIdentity(paths = localSigningPaths()) {
  if (existsSync(paths.keychain) || existsSync(paths.identity)) {
    throw new Error(`a local signing identity already exists at ${paths.root}`)
  }
  quoteSecurityArgument(paths.keychain)
  mkdirSync(paths.root, { recursive: true, mode: 0o700 })
  assertPrivate(paths.root, 'directory')
  const keychainPassword = randomBytes(32).toString('hex')
  const transferPassword = randomBytes(32).toString('hex')
  const wasListed = isInSearchList(paths.keychain)
  writeFileSync(paths.keychainPassword, `${keychainPassword}\n`, { mode: 0o600, flag: 'wx' })
  const scratch = mkdtempSync(join(tmpdir(), 'orca-local-signing-'))
  let createdKeychain = false
  try {
    const config = join(scratch, 'req.cnf')
    writeFileSync(
      config,
      [
        '[req]',
        'distinguished_name = dn',
        'x509_extensions = ext',
        'prompt = no',
        '[dn]',
        `CN = Orca Local Code Signing ${randomBytes(4).toString('hex')}`,
        '[ext]',
        'basicConstraints = critical,CA:false',
        'keyUsage = critical,digitalSignature',
        'extendedKeyUsage = critical,codeSigning',
        'subjectKeyIdentifier = hash',
        ''
      ].join('\n'),
      { mode: 0o600 }
    )
    const key = join(scratch, 'key.pem')
    const cert = join(scratch, 'cert.pem')
    const p12 = join(scratch, 'identity.p12')
    const env = { ...process.env, ORCA_LOCAL_SIGNING_TRANSFER: transferPassword }
    // Why env: argv is visible to every local process; the transient key is encrypted at rest.
    runChecked(
      OPENSSL,
      ['req', '-x509', '-new', '-newkey', 'rsa:3072', '-sha256', '-days', '3650']
        .concat(['-config', config, '-keyout', key, '-out', cert])
        .concat(['-passout', 'env:ORCA_LOCAL_SIGNING_TRANSFER']),
      { env }
    )
    runChecked(
      OPENSSL,
      ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12]
        .concat(['-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'])
        .concat(['-passin', 'env:ORCA_LOCAL_SIGNING_TRANSFER'])
        .concat(['-passout', 'env:ORCA_LOCAL_SIGNING_TRANSFER']),
      { env }
    )
    const certificate = new X509Certificate(readFileSync(cert))
    if (!(certificate.extKeyUsage ?? certificate.keyUsage)?.includes(CODE_SIGNING_EKU)) {
      throw new Error('generated certificate lacks the code signing usage')
    }
    const sha1 = certificate.fingerprint.replaceAll(':', '').toUpperCase()

    const keychain = quoteSecurityArgument(paths.keychain)
    securityWithSecret(`create-keychain -p ${keychainPassword} ${keychain}`)
    createdKeychain = true
    chmodSync(paths.keychain, 0o600)
    securityWithSecret(`unlock-keychain -p ${keychainPassword} ${keychain}`)
    // -x: the private key can never be exported again; -T: only codesign may use it.
    securityWithSecret(
      `import ${quoteSecurityArgument(p12)} -k ${keychain} -f pkcs12 -x -P ${transferPassword} -T ${CODESIGN}`
    )
    // apple-tool: alone is what /usr/bin/codesign needs; apple: would admit every Apple app.
    securityWithSecret(
      `set-key-partition-list -S apple-tool: -s -k ${keychainPassword} ${keychain}`
    )
    // Lock on sleep, no idle timeout: `sign` locks it explicitly, and a timeout could fire mid-run.
    runChecked(SECURITY, ['set-keychain-settings', '-l', paths.keychain])
    runChecked(SECURITY, ['lock-keychain', paths.keychain])
    writeFileSync(
      paths.identity,
      `${JSON.stringify({ sha1, subject: certificate.subject, validTo: certificate.validTo }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' }
    )
    return { sha1, keychain: paths.keychain }
  } catch (error) {
    // Only what this run created; a half-made identity would block the next "create".
    if (createdKeychain) {
      run(SECURITY, ['delete-keychain', paths.keychain])
    }
    rmSync(paths.keychainPassword, { force: true })
    throw error
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    // Why: create-keychain may add itself to the user's search list; prompts must never name it.
    if (!wasListed) {
      removeFromSearchList(paths.keychain)
    }
  }
}

function codesignDetails(path) {
  const result = runChecked(CODESIGN, ['-d', '-vvv', path])
  return parseCodesignDetails(`${result.stdout}\n${result.stderr}`)
}

function designatedRequirement(path) {
  const result = runChecked(CODESIGN, ['-d', '-r-', path])
  const line = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .find((entry) => entry.startsWith('designated => '))
  if (!line) {
    throw new Error(`codesign printed no designated requirement for ${path}`)
  }
  return line.slice('designated => '.length).trim()
}

/**
 * The cdhash of an earlier build, read from that build's bundle after codesign has verified
 * the bundle still matches it. Never from logs or typed hashes: a wrong hash would either miss
 * the old processes or admit code nobody checked.
 */
function readLegacyCdhash(legacyPath, target) {
  const legacy = realpathSync(resolve(legacyPath))
  if (!lstatSync(legacy).isDirectory() || !existsSync(join(legacy, 'Contents', 'Info.plist'))) {
    throw new Error(`${legacy} is not an app bundle`)
  }
  if (isWithin(legacy, target) || isWithin(target, legacy)) {
    throw new Error(`${legacy} overlaps the app being signed`)
  }
  runChecked(CODESIGN, ['--verify', '--deep', '--strict', legacy])
  const details = codesignDetails(legacy)
  if (details.Identifier !== APP_IDENTIFIER) {
    throw new Error(`${legacy} is signed as ${details.Identifier}, not ${APP_IDENTIFIER}`)
  }
  if (!/^[0-9a-f]{40}$/i.test(details.CDHash ?? '')) {
    throw new Error(`${legacy} reported no 20-byte CDHash`)
  }
  return { path: legacy, cdhash: details.CDHash.toLowerCase(), signature: details.Signature }
}

/** Install locations, as real paths: a symlinked parent must not slip an installed app through. */
function installRoots() {
  return ['/Applications', '/System', join(homedir(), 'Applications')]
    .filter((dir) => existsSync(dir))
    .map((dir) => realpathSync(dir))
}

export function signApp(appPath, { paths = localSigningPaths(), legacyApps = [] } = {}) {
  const app = realpathSync(resolve(appPath))
  if (!app.endsWith('.app') || !lstatSync(app).isDirectory()) {
    throw new Error(`${app} is not an app bundle`)
  }
  // Why: sign a build output or scratch copy; the installed app is replaced, never edited.
  const installRoot = installRoots().find((dir) => isWithin(app, dir))
  if (installRoot) {
    throw new Error(`refusing to re-sign an app inside ${installRoot}`)
  }
  if (legacyApps.length > MAX_LEGACY_APPS) {
    throw new Error(`at most ${MAX_LEGACY_APPS} legacy apps`)
  }
  const { identity, password } = readSigningState(paths)
  const legacy = legacyApps.map((path) => readLegacyCdhash(path, app))
  const legacyCdhashes = legacy.map((entry) => entry.cdhash)
  const requirement = localDesignatedRequirement(identity.sha1, legacyCdhashes)
  const terminalHost = join(app, TERMINAL_HOST)
  // Only these two carry the app's identifier, so only they need its requirement.
  const identityBundles = new Set([app, terminalHost])
  const targets = collectSignTargets(app, signIgnorePatterns())
  const keychain = quoteSecurityArgument(paths.keychain)
  const wasListed = isInSearchList(paths.keychain)
  securityWithSecret(`unlock-keychain -p ${password} ${keychain}`)
  try {
    // Why: codesign finds identities through the search list only, even with --keychain.
    if (!wasListed) {
      const list = [...userSearchList(), paths.keychain]
      runChecked(SECURITY, ['list-keychains', '-d', 'user', '-s', ...list])
    }
    try {
      for (const target of targets) {
        const explicit = identityBundles.has(target) ? [`-r=designated => ${requirement}`] : []
        runChecked(
          CODESIGN,
          ['--force', '--sign', identity.sha1, '--keychain', paths.keychain, ...explicit].concat([
            '--timestamp=none',
            '--preserve-metadata=entitlements,flags,runtime',
            target
          ]),
          { timeout: CODESIGN_TIMEOUT_MS }
        )
      }
    } finally {
      // Out of the list before locking, so no lookup meets a locked keychain and asks to unlock it.
      if (!wasListed) {
        removeFromSearchList(paths.keychain)
      }
    }
  } finally {
    run(SECURITY, ['lock-keychain', paths.keychain])
  }

  runChecked(CODESIGN, ['--verify', '--deep', '--strict', app])
  const bundles = existsSync(terminalHost) ? [app, terminalHost] : [app]
  for (const bundle of bundles) {
    const actual = designatedRequirement(bundle)
    if (!isExpectedRequirement(actual, identity.sha1, legacyCdhashes)) {
      throw new Error(`${bundle} has an unexpected designated requirement: ${actual}`)
    }
    // The same check the app runs before launching its daemon from a copy.
    runChecked(CODESIGN, ['--verify', '--strict', '-R', `=${requirement}`, bundle])
  }
  for (const entry of legacy) {
    runChecked(CODESIGN, ['--verify', '--strict', '-R', `=${requirement}`, entry.path])
  }
  return { signed: targets.length, requirement, legacy }
}

function status(paths = localSigningPaths()) {
  if (!existsSync(paths.identity)) {
    return { exists: false, root: paths.root }
  }
  const { identity } = readSigningState(paths)
  return { exists: true, root: paths.root, keychain: paths.keychain, ...identity }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.platform !== 'darwin') {
    throw new Error('local macOS signing runs on macOS only')
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'legacy-app': { type: 'string', multiple: true, default: [] } }
  })
  const [command, target] = positionals
  if (command !== 'sign' && values['legacy-app'].length > 0) {
    throw new Error('--legacy-app applies to sign only')
  }
  if (command === 'create') {
    console.log(JSON.stringify(createSigningIdentity(), null, 2))
  } else if (command === 'sign' && target) {
    console.log(JSON.stringify(signApp(target, { legacyApps: values['legacy-app'] }), null, 2))
  } else if (command === 'plan' && target) {
    console.log(collectSignTargets(resolve(target), signIgnorePatterns()).join('\n'))
  } else if (command === 'status') {
    console.log(JSON.stringify(status(), null, 2))
  } else {
    console.error(
      'usage: mac-local-signing.mjs create | status | plan <Orca.app> | sign <Orca.app> [--legacy-app <old Orca.app>]...'
    )
    process.exitCode = 2
  }
}
