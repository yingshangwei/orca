import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import { buildWindowsAgentHookCurlPostCommand } from '../agent-hooks/installer-utils'

export function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: the endpoint file holds this install's live port/token; sourcing it lets a surviving PTY reach the current server (see claude/hook-service.ts).
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      // Why an empty default: cmd keeps `%CLAUDE_CODE_SESSION_ID%` literal when it is unset.
      'set "ORCA_PARENT_CLAUDE_SESSION="',
      'if defined CLAUDE_CODE_SESSION_ID set "ORCA_PARENT_CLAUDE_SESSION=%CLAUDE_CODE_SESSION_ID%"',
      // Why spliced in: only codex runs as a Claude child, so the shared poster stays as it is.
      buildWindowsAgentHookCurlPostCommand('codex').replace(
        '--data-urlencode "payload@-"',
        '--data-urlencode "parentClaudeSession=%ORCA_PARENT_CLAUDE_SESSION%" --data-urlencode "payload@-"'
      ),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('codex'),
    // Why: sourcing refreshes PORT/TOKEN/ENV/VERSION from the current Orca so a surviving PTY keeps reporting after a restart (see claude/hook-service.ts).
    'load_hook_endpoint() {',
    '  endpoint_path="$1"',
    '  unset ORCA_AGENT_HOOK_TRANSPORT',
    '  case "$endpoint_path" in',
    '    *.cmd)',
    // Why: Windows passes endpoint.cmd into WSL via WSLENV; parse only Orca's known assignments since cmd.exe `set` lines aren't shell syntax.
    '      endpoint_cr=$(printf "\\r")',
    '      while IFS= read -r endpoint_line || [ -n "$endpoint_line" ]; do',
    '        endpoint_line=${endpoint_line%"$endpoint_cr"}',
    '        case "$endpoint_line" in',
    '          "set ORCA_AGENT_HOOK_PORT="*) ORCA_AGENT_HOOK_PORT=${endpoint_line#*=} ;;',
    '          "set ORCA_AGENT_HOOK_TOKEN="*) ORCA_AGENT_HOOK_TOKEN=${endpoint_line#*=} ;;',
    '          "set ORCA_AGENT_HOOK_ENV="*) ORCA_AGENT_HOOK_ENV=${endpoint_line#*=} ;;',
    '          "set ORCA_AGENT_HOOK_VERSION="*) ORCA_AGENT_HOOK_VERSION=${endpoint_line#*=} ;;',
    '          "set ORCA_AGENT_HOOK_TRANSPORT="*) ORCA_AGENT_HOOK_TRANSPORT=${endpoint_line#*=} ;;',
    '        esac',
    '      done < "$endpoint_path"',
    '      ;;',
    '    *)',
    '      . "$endpoint_path" 2>/dev/null || :',
    '      ;;',
    '  esac',
    '}',
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  load_hook_endpoint "$ORCA_AGENT_HOOK_ENDPOINT"',
    'fi',
    // Why: a codex a Claude session started (its Bash tool) inherits this pane key; the server keeps
    // it from replacing the pane's agent. Orca strips this stamp from every PTY it spawns.
    'orca_parent_claude_session="${CLAUDE_CODE_SESSION_ID:-}"',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    'post_codex_hook() {',
    '  curl_bin="$1"',
    '  connect_timeout="${2:-0.5}"',
    '  max_time="${3:-1.5}"',
    // Why: keep full hook JSON off the command line and avoid URL-encoding paths/commands into IDS-friendly traversal signatures.
    ...buildPosixAgentHookPostCommand('codex', {
      curlCommand: '"$curl_bin"',
      indent: '    '
    }).map((line) => `  ${line}`),
    '}',
    'is_wsl_runtime() {',
    '  [ -n "$WSL_DISTRO_NAME" ] && return 0',
    '  grep -qiE "microsoft|wsl" /proc/sys/kernel/osrelease /proc/version 2>/dev/null',
    '}',
    'if post_codex_hook curl >/dev/null 2>&1; then',
    '  exit 0',
    'fi',
    'if is_wsl_runtime; then',
    '  windows_curl=$(command -v curl.exe 2>/dev/null || true)',
    '  if [ -n "$windows_curl" ] && [ -x "$windows_curl" ]; then',
    '    if post_codex_hook "$windows_curl" 3 5 >/dev/null 2>&1; then',
    '      exit 0',
    '    fi',
    '    # post_codex_hook "$windows_curl" 3 5 >/dev/null 2>&1 || true',
    '  fi',
    'fi',
    'spool_hook_event',
    'exit 0',
    ''
  ].join('\n')
}
