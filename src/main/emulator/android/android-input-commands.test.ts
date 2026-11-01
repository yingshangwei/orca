import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { AndroidCommandResult, AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { androidExec, androidTap, androidTypeText } from './android-input-commands'

const SDK: AndroidSdkPaths = {
  sdkRoot: '/sdk',
  adb: '/sdk/adb',
  emulator: '/sdk/emulator',
  avdmanager: '/sdk/avdmanager'
}

const ok: AndroidCommandResult = { stdout: 'ok', stderr: '', code: 0 }
const fail: AndroidCommandResult = { stdout: '', stderr: 'device offline', code: 1 }

describe('android input commands', () => {
  it('throws when adb tap exits non-zero', async () => {
    const runner: AndroidCommandRunner = async () => fail

    await expect(
      androidTap(runner, SDK, 'emulator-5554', 0.5, 0.5, { width: 100, height: 200 })
    ).rejects.toMatchObject({
      code: 'emulator_error',
      message: 'adb tap failed: device offline'
    })
  })

  it('returns stdout for successful exec and throws for failed exec', async () => {
    const successRunner: AndroidCommandRunner = async () => ok
    await expect(androidExec(successRunner, SDK, 'emulator-5554', 'echo ok')).resolves.toBe('ok')

    const failRunner: AndroidCommandRunner = async () => fail
    await expect(androidExec(failRunner, SDK, 'emulator-5554', 'false')).rejects.toMatchObject({
      code: 'emulator_error',
      message: 'adb exec failed: device offline'
    })
  })
})

describe.runIf(process.platform !== 'win32')('Android text shell boundary', () => {
  it.each([
    'plain',
    'hello world',
    "it's fine",
    'hello&world',
    'say "hello"',
    '$ORCA_ANDROID_TEXT_VALUE',
    '$(printf changed)',
    'semi;printf changed',
    '`printf changed`',
    '*',
    'back\\slash',
    ''
  ])('delivers literal text %j as one input argument', async (text) => {
    let output = ''
    const runner: AndroidCommandRunner = async (_binary, args) => {
      const result = spawnSync(
        '/bin/sh',
        ['-c', `input() { printf '%s\\n' "$#" "$@"; }; ${args.slice(3).join(' ')}`],
        {
          encoding: 'utf8',
          env: { ...process.env, ORCA_ANDROID_TEXT_VALUE: 'expanded' }
        }
      )
      if (result.error) {
        throw result.error
      }
      output = result.stdout
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
    }
    await androidTypeText(
      runner,
      { sdkRoot: 'sdk', adb: 'adb', emulator: 'emulator', avdmanager: 'avdmanager' },
      'emulator-5558',
      text
    )
    expect(output).toBe(`2\ntext\n${text.replace(/ /g, '%s')}\n`)
  })
})
