import { assertClaudeEnvironmentUnmodified } from '../../shared/claude-local-policy'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { assertLocalClaudeConfiguration } from './claude-local-configuration'

export async function assertLocalClaudeTerminalLaunch(
  overlay: Record<string, string> | undefined,
  cwd?: string
): Promise<void> {
  const inherited = await resolveLoginShellEnvironment()
  assertClaudeEnvironmentUnmodified(overlay, inherited)
  await assertLocalClaudeConfiguration({ env: { ...inherited, ...overlay }, cwd })
}
