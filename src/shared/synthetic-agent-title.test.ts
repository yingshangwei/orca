import { describe, expect, it } from 'vitest'
import {
  getSyntheticAgentTerminalTitle,
  isSyntheticAgentPermissionTitle,
  shouldDriveSyntheticAgentTitleFromHook
} from './synthetic-agent-title'

describe('synthetic agent titles', () => {
  it.each(['Codex - action required', ' Pi - action required ', 'OMP - action required'])(
    'recognizes the generated permission label %s',
    (title) => {
      expect(isSyntheticAgentPermissionTitle(title)).toBe(true)
    }
  )

  it.each([
    '✋ Gemini CLI',
    'π ! approve command',
    'OpenCode - action required',
    'Codex ready',
    'Codex - action required for deployment'
  ])('keeps native and contextual titles outside generated permission suppression: %s', (title) => {
    expect(isSyntheticAgentPermissionTitle(title)).toBe(false)
  })

  it('provides terminal-state titles for Codex hook completion', () => {
    expect(getSyntheticAgentTerminalTitle('codex', 'done')).toBe('Codex ready')
    expect(getSyntheticAgentTerminalTitle('codex', 'waiting')).toBe('Codex - action required')
  })

  it('does not synthesize Codex working titles over Codex native spinner titles', () => {
    expect(shouldDriveSyntheticAgentTitleFromHook('codex', 'working')).toBe(false)
    expect(shouldDriveSyntheticAgentTitleFromHook('codex', 'done')).toBe(true)
  })

  it.each(['opencode', 'omp'] as const)(
    'keeps %s native session titles in every state',
    (agent) => {
      for (const state of ['done', 'waiting', 'blocked'] as const) {
        expect(getSyntheticAgentTerminalTitle(agent, state)).toBeNull()
        expect(shouldDriveSyntheticAgentTitleFromHook(agent, state)).toBe(false)
      }
      expect(shouldDriveSyntheticAgentTitleFromHook(agent, 'working')).toBe(false)
    }
  )

  it('provides Devin titles for hook-driven status updates', () => {
    expect(getSyntheticAgentTerminalTitle('devin', 'done')).toBe('Devin ready')
    expect(getSyntheticAgentTerminalTitle('devin', 'waiting')).toBe('Devin - action required')
    expect(shouldDriveSyntheticAgentTitleFromHook('devin', 'working')).toBe(true)
  })

  it('provides Pi titles for hook-driven status updates', () => {
    expect(getSyntheticAgentTerminalTitle('pi', 'done')).toBe('Pi ready')
    expect(getSyntheticAgentTerminalTitle('pi', 'waiting')).toBe('Pi - action required')
    expect(shouldDriveSyntheticAgentTitleFromHook('pi', 'working')).toBe(false)
  })
})
