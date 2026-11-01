import { useMemo } from 'react'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import type { MobileNativeChatStructuredComposer } from './MobileNativeChatComposer'
import type { MobileNativeChatFileAttachments } from './use-mobile-native-chat-file-attachments'
import type { useMobileStructuredSessionCommands } from './use-mobile-structured-session-commands'

const NO_COMMANDS: readonly AgentSessionConversationCommand[] = []

/** What a structured chat's composer adds: its session's `/` list, and files where the host
 *  stores them for phones. Null on a terminal-backed chat. */
export function useMobileNativeChatStructuredComposer(args: {
  structured: boolean
  sessionCommands: ReturnType<typeof useMobileStructuredSessionCommands>
  /** The host keeps files a phone uploads; an older one refuses the upload. */
  acceptsFiles: boolean
  conversationCommands: readonly AgentSessionConversationCommand[] | undefined
  files: MobileNativeChatFileAttachments
}): MobileNativeChatStructuredComposer | null {
  const { structured, acceptsFiles, files } = args
  const conversationCommands = args.conversationCommands ?? NO_COMMANDS
  const { commands, refresh } = args.sessionCommands
  const { files: pendingFiles, attachFiles, removeFiles } = files
  // Its own memo: an attach or an upload landing leaves the `/` menu's catalog as it was.
  const catalog = useMemo(
    () => ({ reported: commands, conversationCommands }),
    [commands, conversationCommands]
  )
  return useMemo(
    () =>
      structured
        ? {
            catalog,
            onSlashMenuOpen: refresh,
            ...(acceptsFiles ? { onAttachFiles: () => void attachFiles() } : {}),
            files: pendingFiles,
            onRemoveFile: (id: string) => removeFiles([id])
          }
        : null,
    [acceptsFiles, attachFiles, catalog, pendingFiles, refresh, removeFiles, structured]
  )
}
