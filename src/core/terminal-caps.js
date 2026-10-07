// ============================================================
//  terminal-caps.js — 终端能力探测与开关（零依赖）
// ------------------------------------------------------------
//  负责三件事：
//    1. bracketed paste 开关（多行粘贴不被拆成多次提交）
//    2. Kitty 键盘协议：查询 →（支持才）push flags；退出 pop
//    3. xterm modifyOtherKeys：查询 →（支持才）开启；退出关闭
//
//  为什么「先查询再开启」：不理解这些 CSI 的终端对其反应不一，盲发可能
//  在屏幕上留下乱码；查询有回应才认为支持，最稳。
//
//  ⚠️ 终端事实（Kitty 规范 C0 控制表）：Enter 在**所有修饰组合下都发
//  同一个字节 0xd** —— Shift+Enter / Ctrl+Enter 在协议层无法区分，终端为
//  兼容 `reset` 故意保留传统字节。故开启 Kitty 协议也**不会**让
//  Shift+Enter 可用；它只能让 Esc / alt+key / ctrl+key / ctrl+alt+key 等
//  原本有歧义的组合变得可辨。Shift+Enter 需在终端侧配置（见 /keys 诊断）。
// ============================================================

export const SEQ = {
  pasteOn: '\x1b[?2004h',
  pasteOff: '\x1b[?2004l',
  kittyQuery: '\x1b[?u',            // 查询当前 flags → 终端回 CSI ? <flags> u
  kittyPush: (flags = 1) => `\x1b[>${flags}u`,  // 1 = 仅“消歧”，最保守
  kittyPop: '\x1b[<u',
  mokQuery: '\x1b[?4m',             // 查询 modifyOtherKeys → CSI > 4 ; <level> m
  mokSet: (level = 2) => `\x1b[>4;${level}m`,
  mokOff: '\x1b[>4;0m',
}

/**
 * 探测终端能力（仅在真 TTY 下；需已进入 raw mode 才能及时收到回应）。
 * @returns {Promise<{kitty:boolean, modifyOtherKeys:boolean, buffer:string}>}
 *   buffer 为探测窗口内收到的原始数据（含终端回应；调用方一般丢弃）。
 */
export function probeTerminalCapabilities({ stdin, stdout, timeoutMs = 250 } = {}) {
  const result = { kitty: false, modifyOtherKeys: false, buffer: '' }
  if (!stdin || !stdout || !stdin.isTTY || !stdout.isTTY) return Promise.resolve(result)

  return new Promise((resolve) => {
    let acc = ''
    const onData = (c) => { acc += (typeof c === 'string' ? c : c.toString('utf8')) }
    stdin.on('data', onData)
    try { stdout.write(SEQ.kittyQuery + SEQ.mokQuery) } catch { /* 终端不可写则忽略 */ }

    const finish = () => {
      clearTimeout(timer)
      stdin.removeListener('data', onData)
      result.buffer = acc
      result.kitty = /\x1b\[\?[0-9;]*u/.test(acc)
      result.modifyOtherKeys = /\x1b\[>4;[0-9]+m/.test(acc)
      resolve(result)
    }
    const timer = setTimeout(finish, timeoutMs)
  })
}

/** 开启 Kitty 键盘协议（push flags，默认仅消歧 flag=1） */
export function enableKittyKeyboard(stdout, flags = 1) {
  try { stdout.write(SEQ.kittyPush(flags)); return true } catch { return false }
}
/** 关闭 Kitty 键盘协议（pop，恢复进入前的键盘模式） */
export function disableKittyKeyboard(stdout) {
  try { stdout.write(SEQ.kittyPop) } catch { /* ignore */ }
}
/** 开启 xterm modifyOtherKeys */
export function enableModifyOtherKeys(stdout, level = 2) {
  try { stdout.write(SEQ.mokSet(level)); return true } catch { return false }
}
/** 关闭 xterm modifyOtherKeys */
export function disableModifyOtherKeys(stdout) {
  try { stdout.write(SEQ.mokOff) } catch { /* ignore */ }
}
/** 开关 bracketed paste */
export function enableBracketedPaste(stdout) { try { stdout.write(SEQ.pasteOn) } catch { /* ignore */ } }
export function disableBracketedPaste(stdout) { try { stdout.write(SEQ.pasteOff) } catch { /* ignore */ } }
