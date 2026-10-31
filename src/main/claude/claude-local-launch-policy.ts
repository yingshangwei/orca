import {
  assertClaudeArgumentsUnmodified,
  assertClaudeEnvironmentUnmodified,
  assertClaudeSettingsUnmodified,
  isClaudeConnectionEnvironmentKey,
  refuseClaudeConfigurationMutation
} from '../../shared/claude-local-policy'
import { assertLocalClaudeConfiguration } from './claude-local-configuration'
import type { ClaudeStreamJsonLaunch } from './claude-stream-json-connection'

export async function assertLocalClaudeCommand(input: {
  binary: string
  args: readonly string[]
  env?: Record<string, string>
  inheritedEnv?: NodeJS.ProcessEnv
  cwd?: string
  wslDistro?: string
}): Promise<void> {
  if (input.binary !== 'claude' || input.wslDistro) {
    refuseClaudeConfigurationMutation()
  }
  const env = input.inheritedEnv ?? process.env
  assertClaudeArgumentsUnmodified(input.args)
  assertClaudeEnvironmentUnmodified(input.env, env)
  await assertLocalClaudeConfiguration({ env, cwd: input.cwd })
}

export async function assertLocalClaudeLaunch(launch: ClaudeStreamJsonLaunch): Promise<void> {
  assertClaudeSettingsUnmodified(launch.options.settings)
  assertClaudeArgumentsUnmodified(
    Object.keys(launch.options.extraArgs ?? {}).map((flag) => `--${flag}`)
  )
  if (launch.envToDelete?.some(isClaudeConnectionEnvironmentKey)) {
    refuseClaudeConfigurationMutation()
  }
  await assertLocalClaudeConfiguration({
    env: launch.env ?? process.env,
    cwd: launch.cwd,
    configDir: launch.claudeConfigDir
  })
}
