export const CLAUDE_LOCAL_CONFIGURATION_MESSAGE =
  'Claude connection settings are owned by the local Claude installation and magpie. Orca may select a model and effort, but cannot override the connection.'

export const CLAUDE_NATIVE_PANE_TEAMS_MESSAGE = `${CLAUDE_LOCAL_CONFIGURATION_MESSAGE} Claude Agent Teams native panes require a PATH overlay and are disabled.`

export function refuseClaudeNativePaneTeams(): never {
  throw new Error(CLAUDE_NATIVE_PANE_TEAMS_MESSAGE)
}

export const CLAUDE_DIRECT_REQUEST_MESSAGE =
  'Direct Claude requests are disabled. Use the local Claude CLI configured by magpie.'

export function isClaudeServiceUrl(value: string): boolean {
  let host: string
  try {
    host = new URL(value).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return false
  }
  return ['anthropic.com', 'claude.ai', 'claude.com'].some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  )
}

export function assertNoDirectClaudeRequest(url: string): void {
  if (isClaudeServiceUrl(url)) {
    throw new Error(CLAUDE_DIRECT_REQUEST_MESSAGE)
  }
}

export function isClaudeConnectionEnvironmentKey(name: string): boolean {
  const key = name.toUpperCase()
  return (
    key.startsWith('ANTHROPIC_') ||
    key.startsWith('CLAUDE_CODE_USE_') ||
    key.startsWith('CLAUDE_CODE_OAUTH_') ||
    key.startsWith('AWS_') ||
    key.startsWith('GOOGLE_') ||
    key.startsWith('AZURE_') ||
    [
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'HOME',
      'USERPROFILE',
      'PATH',
      'ORCA_AGENT_TEAMS_SHIM_DIR',
      'NODE_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR'
    ].includes(key)
  )
}

export function assertClaudeEnvironmentUnmodified(
  overlay: Record<string, string | undefined> | undefined,
  inherited: Record<string, string | undefined> = {}
): void {
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (isClaudeConnectionEnvironmentKey(key) && value !== inherited[key]) {
      throw new Error(`${CLAUDE_LOCAL_CONFIGURATION_MESSAGE} Blocked environment key: ${key}`)
    }
  }
}

export function assertClaudeArgumentsUnmodified(args: readonly string[]): void {
  for (const arg of args) {
    if (arg === '--') {
      break
    }
    const flag = arg.split('=', 1)[0]
    if (['--settings', '--setting-sources', '--config-dir', '--env', '--api-key'].includes(flag)) {
      throw new Error(`${CLAUDE_LOCAL_CONFIGURATION_MESSAGE} Blocked argument: ${flag}`)
    }
  }
}

export function refuseClaudeConfigurationMutation(): never {
  throw new Error(CLAUDE_LOCAL_CONFIGURATION_MESSAGE)
}

export function assertClaudeSettingsUnmodified(settings: unknown): void {
  if (settings === undefined) {
    return
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    refuseClaudeConfigurationMutation()
  }
  if ('apiKeyHelper' in settings || 'disableAllHooks' in settings) {
    refuseClaudeConfigurationMutation()
  }
  if ('env' in settings && settings.env && typeof settings.env === 'object') {
    for (const key of Object.keys(settings.env)) {
      if (isClaudeConnectionEnvironmentKey(key)) {
        refuseClaudeConfigurationMutation()
      }
    }
  }
}
