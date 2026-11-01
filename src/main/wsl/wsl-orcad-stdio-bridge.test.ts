import { connect, type Server, type Socket } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { checkOrcadStdioBridge, openOrcadStdioBridgeChannel } from '../ssh/orcad-stdio-bridge'
import { ORCAD_STDIO_BRIDGE_MAX_CHANNELS } from '../managed-server/lifecycle/orcad-stdio-bridge-listener'
import type { OrcadStdioBridgeDependencies } from '../managed-server/lifecycle/orcad-stdio-bridge-provider'
import { startEchoServer } from '../managed-server/lifecycle/orcad-stdio-bridge-test-channel'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import { fakeWslBridgeChildren, posixOrcadStdioBridge } from './wsl-orcad-bridge-test-child'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'

let echo: { server: Server; port: number }
const started: StartedPortForward[] = []
const clients: Socket[] = []

beforeAll(async () => {
  echo = await startEchoServer()
})

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.destroy()
  }
  await Promise.all(started.splice(0).map((forward) => forward.close()))
  vi.restoreAllMocks()
})

afterAll(() => {
  echo.server.close()
})

async function startBridge(
  remotePort = echo.port,
  options: {
    readRunning?: () => Promise<WslRunningDistrosRead>
    resolveBridge?: OrcadStdioBridgeDependencies['resolveBridge']
  } = {}
) {
  const children = fakeWslBridgeChildren()
  const transport = createWslOrcadHostTransport({
    target: { kind: 'wsl', id: 'wsl:ubuntu', distro: 'Ubuntu', label: 'Ubuntu' },
    spawn: children.spawn
  })
  const forward = await listenWslOrcadStdioBridge(
    transport,
    { environmentId: 'wsl:ubuntu', distro: 'Ubuntu', remotePort, localPort: 0, label: 'Ubuntu' },
    {
      resolveBridge: options.resolveBridge ?? (async (_conn, port) => posixOrcadStdioBridge(port)),
      checkBridge: checkOrcadStdioBridge,
      openChannel: openOrcadStdioBridgeChannel
    },
    options.readRunning ?? (async () => ({ status: 'confirmed', distros: ['Ubuntu'] }))
  )
  started.push(forward)
  return { forward, children }
}

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => resolve(socket))
    socket.once('error', reject)
    clients.push(socket)
  })
}

function echoOf(socket: Socket, message: string): Promise<string> {
  return new Promise((resolve) => {
    let received = ''
    const onData = (chunk: Buffer): void => {
      received += chunk.toString('utf8')
      if (received.length >= message.length) {
        socket.off('data', onData)
        resolve(received)
      }
    }
    socket.on('data', onData)
    socket.write(message)
  })
}

function replyOrClose(socket: Socket, message: string): Promise<string> {
  return new Promise((resolve) => {
    let received = ''
    const finish = (value: string): void => {
      socket.off('data', onData)
      socket.off('close', onClose)
      resolve(value)
    }
    const onClose = (): void => finish('closed')
    const onData = (chunk: Buffer): void => {
      received += chunk.toString('utf8')
      if (received.length >= message.length) {
        finish(received)
      }
    }
    if (socket.destroyed) {
      finish('closed')
      return
    }
    socket.on('data', onData)
    socket.once('close', onClose)
    socket.write(message)
  })
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(condition()).toBe(true)
}

describe('listenWslOrcadStdioBridge (real listener, fake wsl.exe echo children)', () => {
  const unconfirmed: WslRunningDistrosRead[] = [
    { status: 'confirmed', distros: [] },
    { status: 'unavailable' }
  ]

  it.each(unconfirmed)(
    'refuses new sockets without guest spawn when running state is $status, then recovers',
    async (stopped) => {
      let running: WslRunningDistrosRead = { status: 'confirmed', distros: ['Ubuntu'] }
      const { forward, children } = await startBridge(echo.port, {
        readRunning: async () => running
      })
      await until(() => children.live() === 0)
      const initialSpawns = children.commands.length
      running = stopped

      for (let i = 0; i <= ORCAD_STDIO_BRIDGE_MAX_CHANNELS; i++) {
        const socket = await dial(forward.entry.localPort)
        expect(await replyOrClose(socket, 'passive')).toBe('closed')
      }
      expect(children.commands).toHaveLength(initialSpawns)
      expect(children.live()).toBe(0)

      running = { status: 'confirmed', distros: ['ubuntu'] }
      const resumed = await dial(forward.entry.localPort)
      expect(await echoOf(resumed, 'resumed')).toBe('resumed')
      expect(children.commands).toHaveLength(initialSpawns + 1)
      expect(children.live()).toBe(1)
    }
  )

  it.each(unconfirmed)(
    'does not resolve a failed bridge again while running state is $status',
    async (stopped) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const resolveBridge = vi
        .fn<OrcadStdioBridgeDependencies['resolveBridge']>()
        .mockRejectedValueOnce(new Error('initial platform probe lost contact'))
        .mockImplementation(async (_host, port) => posixOrcadStdioBridge(port))
      let running = stopped
      const { forward, children } = await startBridge(echo.port, {
        resolveBridge,
        readRunning: async () => running
      })
      expect(resolveBridge).toHaveBeenCalledTimes(1)
      expect(children.commands).toHaveLength(0)

      const refused = await dial(forward.entry.localPort)
      expect(await replyOrClose(refused, 'passive')).toBe('closed')
      expect(resolveBridge).toHaveBeenCalledTimes(1)
      expect(children.commands).toHaveLength(0)

      running = { status: 'confirmed', distros: ['Ubuntu'] }
      const resumed = await dial(forward.entry.localPort)
      expect(await echoOf(resumed, 'after-retry')).toBe('after-retry')
      expect(resolveBridge).toHaveBeenCalledTimes(2)
      expect(children.commands).toHaveLength(1)
    }
  )

  it('rides each accepted socket on its own wsl.exe bridge child', async () => {
    const { forward, children } = await startBridge()
    // The up-front check is one child; it has already exited.
    expect(children.commands).toHaveLength(1)
    await until(() => children.live() === 0)

    const first = await dial(forward.entry.localPort)
    const second = await dial(forward.entry.localPort)
    expect(await echoOf(first, 'one')).toBe('one')
    expect(await echoOf(second, 'two')).toBe('two')
    expect(children.commands).toHaveLength(3)
    expect(children.live()).toBe(2)
    for (const command of children.commands) {
      expect(command).toContain("'.orca-remote/runtimes/node-'*'/bin/node'")
      expect(command).toContain(` ${echo.port}; fi; done;`)
    }
  })

  it(`queues past ${ORCAD_STDIO_BRIDGE_MAX_CHANNELS} sockets and reuses freed slots`, async () => {
    const { forward, children } = await startBridge()
    await until(() => children.live() === 0)
    const count = ORCAD_STDIO_BRIDGE_MAX_CHANNELS + 4
    const sockets = await Promise.all(
      Array.from({ length: count }, () => dial(forward.entry.localPort))
    )
    const first = sockets.slice(0, ORCAD_STDIO_BRIDGE_MAX_CHANNELS)
    await Promise.all(first.map((socket, i) => echoOf(socket, `m${i}`)))
    expect(children.live()).toBe(ORCAD_STDIO_BRIDGE_MAX_CHANNELS)

    for (const socket of first) {
      socket.destroy()
    }
    const rest = sockets.slice(ORCAD_STDIO_BRIDGE_MAX_CHANNELS)
    expect(await Promise.all(rest.map((socket, i) => echoOf(socket, `q${i}`)))).toEqual(
      rest.map((_, i) => `q${i}`)
    )
    expect(children.maxLive()).toBe(ORCAD_STDIO_BRIDGE_MAX_CHANNELS)
    expect(children.commands).toHaveLength(count + 1)
  })

  it('drops a socket whose bridge reports a refused port', async () => {
    const { forward, children } = await startBridge(1)
    const socket = await dial(forward.entry.localPort)
    await new Promise((resolve) => socket.once('close', resolve))
    await until(() => children.live() === 0)
  })

  it('kills every bridge child on close and stops listening', async () => {
    const { forward, children } = await startBridge()
    const sockets = await Promise.all([1, 2, 3].map(() => dial(forward.entry.localPort)))
    await Promise.all(sockets.map((socket, i) => echoOf(socket, `c${i}`)))
    expect(children.live()).toBe(3)

    await forward.close()
    await until(() => children.live() === 0)
    await expect(dial(forward.entry.localPort)).rejects.toThrow()
  })
})
