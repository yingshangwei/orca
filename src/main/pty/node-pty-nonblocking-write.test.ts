import { createRequire } from 'node:module'
import { runProcess } from '@orca/process-host'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const nodePtyPath = require.resolve('node-pty')
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

describeOnPosix('nonblocking PTY input', () => {
  it('delivers input while the filesystem thread pool cannot make progress', async () => {
    const script = `
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const { execFileSync } = require('node:child_process');
      const pty = require(${JSON.stringify(nodePtyPath)});
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-pty-write-'));
      const fifo = path.join(dir, 'blocked');
      execFileSync('/usr/bin/mkfifo', [fifo]);
      let opened = false, statCompleted = false, delivered = false, released = false;
      fs.open(fifo, 'r', (error, fd) => {
        opened = true;
        if (error) throw error;
        fs.closeSync(fd);
      });
      fs.stat(__filename, () => { statCompleted = true; });
      const term = pty.spawn('/bin/sh', ['-c', 'printf READY; read -r line; printf "\\nGOT:%s\\n" "$line"'], {
        cwd: process.cwd(), env: process.env
      });
      function release() {
        if (released) return;
        released = true;
        fs.closeSync(fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK));
      }
      const timeout = setTimeout(() => {
        process.stderr.write('PTY input blocked behind filesystem work');
        process.exitCode = 1;
        release(); term.kill();
      }, 4000);
      let output = '', sent = false;
      term.onData(data => {
        output += data;
        if (!sent && output.includes('READY')) {
          sent = true;
          term.write('input-roundtrip\\n');
        }
        if (!delivered && output.includes('GOT:input-roundtrip')) {
          delivered = true;
          console.log(JSON.stringify({ delivered, opened, statCompleted }));
          release();
        }
      });
      term.onExit(() => {
        clearTimeout(timeout);
        release();
        fs.rmSync(dir, { recursive: true, force: true });
        if (!delivered) process.exitCode = 1;
      });
    `
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', script],
      env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
      timeoutMs: 10_000,
      maxOutputBytes: 16_384
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      delivered: true,
      opened: false,
      statCompleted: false
    })
  })

  it('yields on backpressure and preserves a large UTF-8 input exactly', async () => {
    const script = `
      const { createHash } = require('node:crypto');
      const pty = require(${JSON.stringify(nodePtyPath)});
      const payload = Buffer.from('输入恢复 abc123\\n'.repeat(32768));
      const expected = createHash('sha256').update(payload).digest('hex');
      const child = 'process.stdin.setRawMode(true);let n=0;const h=require("node:crypto").createHash("sha256");process.stdin.on("data",b=>{n+=b.length;h.update(b);if(n===' + payload.length + '){console.log("DIGEST:"+h.digest("hex"));process.exit(0)}});console.log("READY")';
      const term = pty.spawn(process.execPath, ['-e', child], { cwd: process.cwd(), env: process.env });
      let output = '', sent = false, yielded = false, delivered = false;
      const timeout = setTimeout(() => {
        process.kill(term.pid, 'SIGCONT'); term.kill(); process.exitCode = 1;
      }, 5000);
      term.onData(data => {
        output += data;
        if (!sent && output.includes('READY')) {
          sent = true;
          process.kill(term.pid, 'SIGSTOP');
          term.write(payload);
          setImmediate(() => { yielded = true; process.kill(term.pid, 'SIGCONT'); });
        }
        if (output.includes('DIGEST:' + expected)) delivered = true;
      });
      term.onExit(() => {
        clearTimeout(timeout);
        console.log(JSON.stringify({ delivered, yielded }));
        if (!delivered || !yielded) process.exitCode = 1;
      });
    `
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', script],
      timeoutMs: 10_000,
      maxOutputBytes: 16_384
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ delivered: true, yielded: true })
  })
})
