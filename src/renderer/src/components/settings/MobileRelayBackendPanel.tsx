import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '../../i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import {
  applyMobileRelayBackendConfig,
  useMobileRelayBackend
} from '../mobile/use-mobile-relay-backend'
import type {
  MobileRelayBackendError,
  MobileRelayBackendProvider,
  MobileRelayBackendUpdate
} from '../../../../shared/mobile-relay-backend'

function backendErrorText(error: MobileRelayBackendError): string {
  switch (error) {
    case 'config_unreadable':
      return translate(
        'auto.components.settings.MobileRelayBackendPanel.configUnreadable',
        'Relay settings can’t be read. Choose Orca to discard them, or save a self-hosted URL and access key.'
      )
    case 'access_key_unreadable':
      return translate(
        'auto.components.settings.MobileRelayBackendPanel.accessKeyUnreadable',
        'The saved access key can’t be unlocked. Unlock the system keychain, or enter the key again.'
      )
    case 'secret_protection_unavailable':
      return translate(
        'auto.components.settings.MobileRelayBackendPanel.secretProtectionUnavailable',
        'The system keychain is unavailable, so the access key was not saved.'
      )
    case 'invalid_origin':
      return translate(
        'auto.components.settings.MobileRelayBackendPanel.invalidOrigin',
        'Enter an HTTPS origin such as https://relay.example.com, with no path.'
      )
    case 'invalid_access_key':
      return translate(
        'auto.components.settings.MobileRelayBackendPanel.invalidAccessKey',
        'The access key must be 43 characters.'
      )
    case 'access_key_required':
      return translate(
        'auto.components.settings.MobileRelayBackendPanel.accessKeyRequired',
        'Enter the access key for this relay URL.'
      )
    case 'self_hosted_not_configured':
      return translate(
        'auto.components.settings.MobileRelayBackendPanel.notConfigured',
        'Save a relay URL and access key before switching to it.'
      )
    case 'config_write_failed':
      return translate(
        'auto.components.settings.MobileRelayBackendPanel.writeFailed',
        'The Relay backend settings could not be saved.'
      )
  }
}

export function MobileRelayBackendPanel(): React.JSX.Element | null {
  const { config } = useMobileRelayBackend()
  const originId = useId()
  const accessKeyId = useId()
  const [draftProvider, setDraftProvider] = useState<MobileRelayBackendProvider>(
    config?.provider ?? 'official'
  )
  const [origin, setOrigin] = useState(config?.selfHosted.origin ?? '')
  // Why never prefilled: the saved key stays in main; this field only replaces it.
  const [accessKey, setAccessKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<MobileRelayBackendError | null>(null)

  const savedProvider = config?.provider
  const savedOrigin = config?.selfHosted.origin ?? null
  const savedAt = config?.selfHosted.savedAt ?? null
  // Why keyed on saved values: a failed save republishes the same config and
  // must not discard the form the user is still editing.
  useEffect(() => {
    if (savedProvider) {
      setDraftProvider(savedProvider)
    }
  }, [savedProvider])
  useEffect(() => {
    setOrigin(savedOrigin ?? '')
  }, [savedOrigin, savedAt])

  if (!config || !window.api.mobile.updateRelayBackend) {
    return null
  }

  const submit = async (input: MobileRelayBackendUpdate): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.mobile.updateRelayBackend?.(input)
      if (!result) {
        return
      }
      applyMobileRelayBackendConfig(result.config)
      if (result.ok) {
        setAccessKey('')
      } else {
        setError(result.error)
      }
    } catch {
      setError('config_write_failed')
    } finally {
      setSaving(false)
    }
  }

  const selectProvider = (next: string): void => {
    if (next !== 'official' && next !== 'self-hosted') {
      return
    }
    setDraftProvider(next)
    setError(null)
    // Why: an unsaved self-hosted backend only reveals the form; Save switches.
    if (next === 'official' || config.selfHosted.configured) {
      void submit({
        provider: next,
        ...(next === 'official' && config.error === 'config_unreadable'
          ? { resetUnreadable: true as const }
          : {})
      })
    }
  }

  const copyPublicKey = async (): Promise<void> => {
    if (!config.hostPublicKeyB64) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(config.hostPublicKeyB64)
      toast.success(
        translate(
          'auto.components.settings.MobileRelayBackendPanel.publicKeyCopied',
          'Desktop public key copied'
        )
      )
    } catch {
      toast.error(
        translate(
          'auto.components.settings.MobileRelayBackendPanel.publicKeyCopyFailed',
          'Failed to copy the public key'
        )
      )
    }
  }

  const shownError = error ?? config.error
  const originChanged = origin.trim().replace(/\/$/, '') !== (savedOrigin ?? '')

  return (
    <div
      // Why role-less: a radiogroup may only own radios; this div is layout under the Relay radio.
      onKeyDown={(event) => {
        // Why: arrow keys on nested controls must not change the selected path.
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.stopPropagation()
        }
      }}
      className="space-y-2 border-t border-border/60 py-2.5 pl-10 pr-3"
      data-testid="relay-backend-panel"
    >
      <ToggleGroup
        type="single"
        variant="outline"
        size="xs"
        value={
          config.error === 'config_unreadable' && draftProvider === 'official' ? '' : draftProvider
        }
        onValueChange={selectProvider}
        disabled={saving}
        aria-label={translate(
          'auto.components.settings.MobileRelayBackendPanel.backendGroup',
          'Relay backend'
        )}
      >
        <ToggleGroupItem value="official">
          {translate('auto.components.settings.MobileRelayBackendPanel.official', 'Orca')}
        </ToggleGroupItem>
        <ToggleGroupItem value="self-hosted">
          {translate('auto.components.settings.MobileRelayBackendPanel.selfHosted', 'Self-hosted')}
        </ToggleGroupItem>
      </ToggleGroup>
      {draftProvider === 'self-hosted' ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            const key = accessKey.trim()
            void submit({
              provider: 'self-hosted',
              selfHosted: key ? { origin, accessKey: key } : { origin }
            })
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={originId}>
              {translate(
                'auto.components.settings.MobileRelayBackendPanel.originLabel',
                'Relay URL'
              )}
            </Label>
            <Input
              id={originId}
              density="compact"
              value={origin}
              placeholder={translate(
                'auto.components.settings.MobileRelayBackendPanel.originPlaceholder',
                'https://relay.example.com'
              )}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={shownError === 'invalid_origin'}
              onChange={(event) => setOrigin(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={accessKeyId}>
              {translate(
                'auto.components.settings.MobileRelayBackendPanel.accessKeyLabel',
                'Access key'
              )}
            </Label>
            <Input
              id={accessKeyId}
              type="password"
              density="compact"
              value={accessKey}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                config.selfHosted.hasAccessKey && !originChanged
                  ? translate(
                      'auto.components.settings.MobileRelayBackendPanel.accessKeySaved',
                      'Saved — enter a new key to replace it'
                    )
                  : translate(
                      'auto.components.settings.MobileRelayBackendPanel.accessKeyPlaceholder',
                      'Access key from your relay'
                    )
              }
              aria-invalid={
                shownError === 'invalid_access_key' || shownError === 'access_key_required'
              }
              onChange={(event) => setAccessKey(event.target.value)}
            />
            {originChanged && config.selfHosted.hasAccessKey ? (
              <p className="text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.settings.MobileRelayBackendPanel.newOriginNeedsKey',
                  'A different relay URL needs its own access key.'
                )}
              </p>
            ) : null}
          </div>
          {config.hostPublicKeyB64 ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.MobileRelayBackendPanel.publicKeyDetail',
                  'Enroll this desktop on your relay with its public key.'
                )}
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                  {config.hostPublicKeyB64}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="shrink-0"
                  onClick={() => void copyPublicKey()}
                >
                  {translate(
                    'auto.components.settings.MobileRelayBackendPanel.copyPublicKey',
                    'Copy public key'
                  )}
                </Button>
              </div>
            </div>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.MobileRelayBackendPanel.pushUnavailable',
              'Background notifications are off while a self-hosted relay is selected. Phones paired with Orca’s relay keep their pairing.'
            )}
          </p>
          {shownError ? (
            <p className="text-xs text-destructive" role="alert">
              {backendErrorText(shownError)}
            </p>
          ) : null}
          <Button type="submit" size="xs" disabled={saving}>
            {config.provider === 'self-hosted'
              ? translate('auto.components.settings.MobileRelayBackendPanel.save', 'Save')
              : translate(
                  'auto.components.settings.MobileRelayBackendPanel.saveAndUse',
                  'Save and use'
                )}
          </Button>
        </form>
      ) : shownError ? (
        <p className="text-xs text-destructive" role="alert">
          {backendErrorText(shownError)}
        </p>
      ) : null}
    </div>
  )
}
