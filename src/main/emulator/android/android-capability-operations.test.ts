import { describe, expect, it, vi } from 'vitest'
import type { AndroidCommandResult, AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import {
  captureAndroidLogcat,
  dumpAndroidAccessibilityTree,
  installAndroidApk,
  launchAndroidApp,
  setAndroidPermission
} from './android-capability-operations'

const SDK: AndroidSdkPaths = {
  sdkRoot: '/sdk',
  adb: '/sdk/adb',
  emulator: '/sdk/emulator',
  avdmanager: '/sdk/avdmanager'
}

const ok = (stdout: string): AndroidCommandResult => ({ stdout, stderr: '', code: 0 })

function runnerReturning(map: Record<string, AndroidCommandResult>): AndroidCommandRunner {
  return (async (_binary: string, args: readonly string[]) =>
    map[args.join(' ')] ?? ok('')) as unknown as AndroidCommandRunner
}

describe('installAndroidApk', () => {
  it('installs and throws on a Failure stdout even with exit 0', async () => {
    const good = vi.fn(runnerReturning({ '-s s install /a.apk': ok('Success') }))
    await installAndroidApk(good as unknown as AndroidCommandRunner, SDK, 's', '/a.apk')
    expect(good).toHaveBeenCalledWith(SDK.adb, ['-s', 's', 'install', '/a.apk'])

    const bad = runnerReturning({ '-s s install /a.apk': ok('Failure [INSTALL_FAILED]') })
    await expect(installAndroidApk(bad, SDK, 's', '/a.apk')).rejects.toMatchObject({
      code: 'emulator_error'
    })
  })

  it('passes -r when reinstalling', async () => {
    const runner = vi.fn(runnerReturning({ '-s s install -r /a.apk': ok('Success') }))
    await installAndroidApk(runner as unknown as AndroidCommandRunner, SDK, 's', '/a.apk', {
      reinstall: true
    })
    expect(runner).toHaveBeenCalledWith(SDK.adb, ['-s', 's', 'install', '-r', '/a.apk'])
  })
})

describe('launchAndroidApp + setAndroidPermission', () => {
  it('launches with an explicit activity', async () => {
    const runner = vi.fn(runnerReturning({}))
    await launchAndroidApp(runner as unknown as AndroidCommandRunner, SDK, 's', 'com.x', '.Main')
    expect(runner).toHaveBeenCalledWith(SDK.adb, [
      '-s',
      's',
      'shell',
      'am',
      'start',
      '-n',
      'com.x/.Main'
    ])
  })

  it('grants a runtime permission', async () => {
    const runner = vi.fn(runnerReturning({}))
    await setAndroidPermission(
      runner as unknown as AndroidCommandRunner,
      SDK,
      's',
      'grant',
      'com.x',
      'android.permission.CAMERA'
    )
    expect(runner).toHaveBeenCalledWith(SDK.adb, [
      '-s',
      's',
      'shell',
      'pm',
      'grant',
      'com.x',
      'android.permission.CAMERA'
    ])
  })
})

describe('dumpAndroidAccessibilityTree', () => {
  it('dumps then reads and parses the XML hierarchy', async () => {
    const xml = '<hierarchy><node text="Hello" bounds="[0,0][10,10]"/></hierarchy>'
    const runner = runnerReturning({ '-s s shell cat /sdcard/window_dump.xml': ok(xml) })
    const tree = await dumpAndroidAccessibilityTree(runner, SDK, 's')
    expect(tree.children[0]).toMatchObject({ text: 'Hello' })
  })
})

describe('captureAndroidLogcat', () => {
  it('dumps and parses non-empty logcat lines', async () => {
    const line = '06-26 12:00:00.123  1234  5678 D MyTag: hello'
    const runner = runnerReturning({ '-s s logcat -d -v threadtime': ok(`${line}\n`) })
    const entries = await captureAndroidLogcat(runner, SDK, 's')
    expect(entries).toEqual([
      { timestamp: '06-26 12:00:00.123', level: 'D', tag: 'MyTag', message: 'hello' }
    ])
  })
})

describe('dumpAndroidAccessibilityTree', () => {
  it.each([
    { stdout: '', stderr: 'ERROR: could not get idle state.' },
    { stdout: 'ERROR: could not get idle state.', stderr: 'WARNING: diagnostic output' }
  ])('rejects a zero-exit dump failure before reading stale XML: %j', async (diagnostic) => {
    const runner = vi.fn<AndroidCommandRunner>().mockResolvedValueOnce({ ...diagnostic, code: 0 })
    runner.mockResolvedValue(ok('<hierarchy><node text="Old screen"/></hierarchy>'))

    await expect(dumpAndroidAccessibilityTree(runner, SDK, 's')).rejects.toMatchObject({
      code: 'emulator_error',
      message: expect.stringContaining('ERROR:')
    })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('reads a successful dump despite unrelated stderr warnings', async () => {
    const runner = vi.fn<AndroidCommandRunner>()
    runner.mockResolvedValueOnce({
      code: 0,
      stdout: 'UI hierchary dumped to: /sdcard/window_dump.xml',
      stderr: 'WARNING: diagnostic output'
    })
    runner.mockResolvedValueOnce(ok('<hierarchy><node text="Current screen"/></hierarchy>'))

    const tree = await dumpAndroidAccessibilityTree(runner, SDK, 's')
    expect(tree.children[0]).toMatchObject({ text: 'Current screen' })
    expect(runner).toHaveBeenCalledTimes(2)
  })
})

describe('launchAndroidApp', () => {
  it.each([
    { stdout: '', stderr: 'Error type 3\nError: Activity class {com.x/.Missing} does not exist.' },
    { stdout: 'Error: Activity class {com.x/.Missing} does not exist.', stderr: '' }
  ])('rejects a zero-exit activity launch failure: %j', async (diagnostic) => {
    const runner = vi.fn<AndroidCommandRunner>().mockResolvedValue({ ...diagnostic, code: 0 })

    await expect(launchAndroidApp(runner, SDK, 's', 'com.x', '.Missing')).rejects.toMatchObject({
      code: 'emulator_error',
      message: expect.stringContaining('Error:')
    })
  })

  it('accepts a successful launch with a brought-to-front warning', async () => {
    const runner = vi.fn<AndroidCommandRunner>().mockResolvedValue({
      code: 0,
      stdout: 'Starting: Intent { cmp=com.Error/.ErrorActivity }',
      stderr: 'Warning: Activity not started, its current task has been brought to the front'
    })

    await expect(
      launchAndroidApp(runner, SDK, 's', 'com.Error', '.ErrorActivity')
    ).resolves.toBeUndefined()
  })
})
