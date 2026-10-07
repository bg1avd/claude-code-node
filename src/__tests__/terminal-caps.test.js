import { test } from 'node:test'
import assert from 'node:assert'
import { PassThrough, Writable } from 'node:stream'
import {
  probeTerminalCapabilities, enableKittyKeyboard, disableKittyKeyboard,
  enableModifyOtherKeys, disableModifyOtherKeys, enableBracketedPaste,
  disableBracketedPaste, SEQ,
} from '../core/terminal-caps.js'

function mkStreams() {
  const stdin = new PassThrough()
  stdin.isTTY = true
  const stdout = new Writable({ write(c, _e, cb) { this.buf += c.toString(); cb() } })
  stdout.buf = ''
  stdout.isTTY = true
  return { stdin, stdout }
}

test('probe：终端回应 CSI ? <flags> u → 判定 Kitty 支持', async () => {
  const { stdin, stdout } = mkStreams()
  const p = probeTerminalCapabilities({ stdin, stdout, timeoutMs: 60 })
  stdin.write('\x1b[?1u')
  const caps = await p
  assert.strictEqual(caps.kitty, true)
  assert.ok(stdout.buf.includes('\x1b[?u'), '应发出 Kitty 查询序列')
})

test('probe：无回应 → 超时返回均不支持', async () => {
  const { stdin, stdout } = mkStreams()
  const caps = await probeTerminalCapabilities({ stdin, stdout, timeoutMs: 30 })
  assert.strictEqual(caps.kitty, false)
  assert.strictEqual(caps.modifyOtherKeys, false)
})

test('probe：回应 CSI > 4 ; level m → 判定 modifyOtherKeys 支持', async () => {
  const { stdin, stdout } = mkStreams()
  const p = probeTerminalCapabilities({ stdin, stdout, timeoutMs: 60 })
  stdin.write('\x1b[>4;2m')
  const caps = await p
  assert.strictEqual(caps.modifyOtherKeys, true)
})

test('probe：非 TTY 直接返回不支持', async () => {
  const caps = await probeTerminalCapabilities({ stdin: {}, stdout: {} })
  assert.deepStrictEqual(caps, { kitty: false, modifyOtherKeys: false, buffer: '' })
})

test('开关序列拼装正确', () => {
  const { stdout } = mkStreams()
  enableKittyKeyboard(stdout, 1)
  disableKittyKeyboard(stdout)
  enableModifyOtherKeys(stdout, 2)
  disableModifyOtherKeys(stdout)
  enableBracketedPaste(stdout)
  disableBracketedPaste(stdout)
  assert.strictEqual(
    stdout.buf,
    SEQ.kittyPush(1) + SEQ.kittyPop + SEQ.mokSet(2) + SEQ.mokOff + SEQ.pasteOn + SEQ.pasteOff,
  )
})
