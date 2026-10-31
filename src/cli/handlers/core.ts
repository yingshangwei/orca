import type { CommandHandler } from '../dispatch'
import { CLAUDE_NATIVE_PANE_TEAMS_MESSAGE } from '../../shared/claude-local-policy'
import { formatCliStatus, formatStatus, printResult } from '../format'
import { RuntimeClientError, serveOrcaApp } from '../runtime-client'
import { resolveCliStatusCaller } from '../runtime/status-caller'
import { getServeSuperviseValidationError } from '../runtime/serve-supervised-service'
import { getOptionalServePort } from '../runtime/serve-port-flag'
import { getServeOptionValidationError } from '../../shared/serve-option-validation'

export const CORE_HANDLERS: Record<string, CommandHandler> = {
  'claude-teams': async () => {
    throw new RuntimeClientError(
      'claude_local_configuration_required',
      CLAUDE_NATIVE_PANE_TEAMS_MESSAGE
    )
  },
  open: async ({ client, json }) => {
    const result = await client.openOrca()
    printResult(result, json, formatCliStatus)
  },
  serve: async ({ flags, json }) => {
    const projectRootValue = flags.get('project-root')
    const projectRoot = typeof projectRootValue === 'string' ? projectRootValue : null
    const noPairing = flags.get('no-pairing') === true
    const mobilePairing = flags.get('mobile-pairing') === true
    const grantDesktopControl = flags.get('grant-desktop-control') === true
    const recipeJson = flags.get('recipe-json') === true
    const force = flags.get('force') === true
    const supervise = flags.get('supervise') === true
    const superviseError = getServeSuperviseValidationError({ supervise, recipeJson })
    if (superviseError) {
      throw new RuntimeClientError('invalid_argument', superviseError)
    }
    const validationError = getServeOptionValidationError({
      noPairing,
      mobilePairing,
      grantDesktopControl,
      recipeJson,
      projectRoot
    })
    if (validationError) {
      throw new RuntimeClientError('invalid_argument', validationError)
    }
    const port = getOptionalServePort(flags)
    const pairingAddressValue = flags.get('pairing-address')
    const exitCode = await serveOrcaApp({
      json,
      port,
      pairingAddress: typeof pairingAddressValue === 'string' ? pairingAddressValue : null,
      noPairing,
      mobilePairing,
      grantDesktopControl,
      recipeJson,
      projectRoot,
      ...(force ? { force: true } : {}),
      ...(supervise ? { supervise: true } : {})
    })
    process.exitCode = exitCode
  },
  status: async ({ client, json }) => {
    const result = await client.getCliStatus()
    if (!json && !result.result.runtime.reachable) {
      process.exitCode = 1
    }
    const caller = result.result.runtime.reachable
      ? await resolveCliStatusCaller(client)
      : undefined
    printResult(
      caller === undefined ? result : { ...result, result: { ...result.result, caller } },
      json,
      formatStatus
    )
  }
}
