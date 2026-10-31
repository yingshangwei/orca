import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  readPaneIdentitySnapshot,
  waitForActivePaneHookDescriptor,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  claudeTranscriptLines,
  enableNativeChatSetting,
  seedClaudeProviderSession
} from './helpers/native-chat-transcript-fixture'

test('header returns to the same conversation and reads messages added while in terminal view', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => window.__store?.getState().updateSettings({ uiLanguage: 'en' }))
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  await expect
    .poll(async () =>
      Object.values((await readPaneIdentitySnapshot(orcaPage))?.ptyIdsByLeafId ?? {})
    )
    .not.toEqual([])
  const before = await readPaneIdentitySnapshot(orcaPage)
  expect(before?.panes[0]?.ptyId).toBeTruthy()
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-chat-header-'))
  const sessionId = randomUUID()
  const transcriptPath = path.join(scratch, `${sessionId}.jsonl`)
  const first = {
    sessionId,
    messageIdPrefix: 'first',
    userText: 'Add a personal learning section.',
    assistantText: 'The personal learning section is saved.'
  }
  const recent = {
    sessionId,
    messageIdPrefix: 'recent',
    userText: 'Save reference documents with a short description.',
    assistantText: 'The reference documents and short descriptions are saved.'
  }
  writeFileSync(transcriptPath, claudeTranscriptLines(first))
  try {
    await enableNativeChatSetting(orcaPage)
    await seedClaudeProviderSession(orcaPage, { ...descriptor, sessionId, transcriptPath })
    const showChat = orcaPage.getByRole('button', { name: 'Continue in Chat UI', exact: true })
    const showTerminal = orcaPage.getByRole('button', { name: 'Show terminal', exact: true })
    const chat = orcaPage.locator('[data-native-chat-root="true"]:visible')

    await showChat.click()
    await expect(chat.getByText(first.userText, { exact: true })).toBeVisible()
    await expect(chat.getByText(first.assistantText, { exact: true })).toBeVisible()
    await showTerminal.click()
    await expect(chat).toHaveCount(0)

    appendFileSync(transcriptPath, claudeTranscriptLines(recent))
    await showChat.click()
    for (const text of [
      first.userText,
      first.assistantText,
      recent.userText,
      recent.assistantText
    ]) {
      await expect(chat.getByText(text, { exact: true })).toBeVisible()
    }
    await showTerminal.click()
    await showChat.click()
    await expect(chat.getByText(recent.assistantText, { exact: true })).toBeVisible()
    const after = await readPaneIdentitySnapshot(orcaPage)
    expect(after?.tabId).toBe(before?.tabId)
    expect(after?.ptyIdsByLeafId).toEqual(before?.ptyIdsByLeafId)
    expect(after?.panes.map((pane) => pane.leafId)).toEqual(
      before?.panes.map((pane) => pane.leafId)
    )
    expect(
      await orcaPage.evaluate(
        (paneKey) => window.__store?.getState().agentStatusByPaneKey[paneKey]?.providerSession?.id,
        descriptor.paneKey
      )
    ).toBe(sessionId)
    await orcaPage.screenshot({ path: testInfo.outputPath('same-session-history.png') })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
