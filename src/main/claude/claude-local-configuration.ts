import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  CLAUDE_LOCAL_CONFIGURATION_MESSAGE,
  isClaudeConnectionEnvironmentKey
} from '../../shared/claude-local-policy'

type Settings = Record<string, unknown>

function record(value: unknown): Settings {
  return isSettings(value) ? value : {}
}

function isSettings(value: unknown): value is Settings {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readSettings(path: string): Promise<Settings> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    throw new Error(`${CLAUDE_LOCAL_CONFIGURATION_MESSAGE} Cannot read ${path}`)
  }
  try {
    return record(JSON.parse(content))
  } catch {
    throw new Error(`${CLAUDE_LOCAL_CONFIGURATION_MESSAGE} Invalid JSON in ${path}`)
  }
}

export function localClaudeConfigDirectory(env: NodeJS.ProcessEnv): string {
  return resolve(env.CLAUDE_CONFIG_DIR || join(env.HOME || env.USERPROFILE || homedir(), '.claude'))
}

function managedSettingsPaths(env: NodeJS.ProcessEnv): string[] {
  if (process.platform === 'darwin') {
    return ['/Library/Application Support/ClaudeCode/managed-settings.json']
  }
  if (process.platform === 'win32') {
    return [env.ProgramData || 'C:\\ProgramData', env.ProgramFiles || 'C:\\Program Files'].map(
      (root) => join(root, 'ClaudeCode', 'managed-settings.json')
    )
  }
  return ['/etc/claude-code/managed-settings.json']
}

function requireLocalEndpoint(value: unknown): void {
  if (typeof value === 'string') {
    try {
      const url = new URL(value)
      if (
        ['http:', 'https:'].includes(url.protocol) &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ) {
        return
      }
    } catch {
      // The refusal below omits the value, which can contain credentials.
    }
  }
  throw new Error(
    `${CLAUDE_LOCAL_CONFIGURATION_MESSAGE} Configure a local ANTHROPIC_BASE_URL in Claude settings before starting Claude.`
  )
}

export async function assertLocalClaudeConfiguration(input: {
  env: NodeJS.ProcessEnv
  cwd?: string
  configDir?: string
}): Promise<void> {
  const configDir = localClaudeConfigDirectory(input.env)
  if (input.env.ORCA_CLAUDE_INJECTED_CONFIG_DIR || input.env.ORCA_CLAUDE_PROFILE_POINTER) {
    throw new Error(`${CLAUDE_LOCAL_CONFIGURATION_MESSAGE} Inherited Orca account override.`)
  }
  if (input.configDir && resolve(input.configDir) !== configDir) {
    throw new Error(
      `${CLAUDE_LOCAL_CONFIGURATION_MESSAGE} Alternate Claude configuration directory.`
    )
  }
  const userPath = join(configDir, 'settings.json')
  const userSettings = await readSettings(userPath)
  const userEnv = record(userSettings.env)
  requireLocalEndpoint(userEnv.ANTHROPIC_BASE_URL)
  const baseline = { ...input.env, ...userEnv }
  for (const [key, value] of Object.entries(baseline)) {
    if (
      key.toUpperCase().startsWith('CLAUDE_CODE_USE_') &&
      value &&
      !['0', 'false'].includes(String(value))
    ) {
      throw new Error(`${CLAUDE_LOCAL_CONFIGURATION_MESSAGE} Blocked provider switch: ${key}`)
    }
  }
  const paths = new Set(managedSettingsPaths(input.env))
  for (let directory = resolve(input.cwd ?? process.cwd()); ; directory = dirname(directory)) {
    paths.add(join(directory, '.claude', 'settings.json'))
    paths.add(join(directory, '.claude', 'settings.local.json'))
    if (directory === dirname(directory)) {
      break
    }
  }
  paths.delete(userPath)
  for (const path of paths) {
    const settings = await readSettings(path)
    for (const [key, value] of Object.entries(record(settings.env))) {
      if (isClaudeConnectionEnvironmentKey(key) && value !== baseline[key]) {
        throw new Error(`${CLAUDE_LOCAL_CONFIGURATION_MESSAGE} Conflicting ${key} in ${path}`)
      }
    }
    if (
      settings.apiKeyHelper !== undefined &&
      settings.apiKeyHelper !== userSettings.apiKeyHelper
    ) {
      throw new Error(`${CLAUDE_LOCAL_CONFIGURATION_MESSAGE} Conflicting apiKeyHelper in ${path}`)
    }
  }
}
