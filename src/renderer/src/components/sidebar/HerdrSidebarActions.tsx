import { useRef, useState } from 'react'
import { Loader2, RefreshCw, TerminalSquare } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function HerdrSidebarActions(): React.JSX.Element | null {
  const [busy, setBusy] = useState<'open' | 'sync' | null>(null)
  const pending = useRef(false)
  const api = window.api?.herdr
  if (!api) {
    return null
  }
  const run = async (action: 'open' | 'sync'): Promise<void> => {
    if (pending.current) {
      return
    }
    pending.current = true
    setBusy(action)
    try {
      if (action === 'open') {
        await api.openTerminal()
      } else {
        const result = await api.sync()
        const message = translate(
          'herdr.synced',
          'Connected {{count}} Herdr terminals; added {{added}}.',
          {
            count: result.connected,
            added: result.added
          }
        )
        if (result.issues.length > 0) {
          toast.warning(message, {
            description: result.issues
              .map((issue) => `${issue.paneId}: ${issue.message}`)
              .join('\n'),
            duration: 10_000
          })
        } else {
          toast.success(message)
        }
      }
    } catch (error) {
      toast.error(translate('herdr.failed', 'Herdr action failed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      pending.current = false
      setBusy(null)
    }
  }
  const className =
    'w-full justify-start gap-2 px-2 text-[13px] text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8 hover:text-worktree-sidebar-foreground'
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={className}
        disabled={busy !== null}
        onClick={() => void run('open')}
      >
        <TerminalSquare />
        {translate('herdr.open', 'Open Herdr in Terminal')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={className}
        disabled={busy !== null}
        onClick={() => void run('sync')}
      >
        {busy === 'sync' ? (
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <RefreshCw />
        )}
        {busy === 'sync'
          ? translate('herdr.syncing', 'Syncing Herdr…')
          : translate('herdr.sync', 'Sync Herdr windows')}
      </Button>
    </>
  )
}
