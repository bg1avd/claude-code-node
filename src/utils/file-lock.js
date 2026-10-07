/**
 * 文件级串行锁 —— 防止「同一文件被并发读写」导致的内容损坏 / 编辑丢失。
 *
 * 根因（2026-10-06 实锤）：引擎 `_executeToolCalls` 的**阶段2 用 `Promise.all` 并行执行**
 * 一批工具调用。若同一轮里对**同一个文件**发了多个 Edit/Write，并发执行会互相踩踏：
 *
 *   1) 编辑丢失：各自 readFile 到同一份旧内容 → 计算出的新内容互相覆盖，最后写者胜，
 *      先写的改动被吞掉。
 *   2) 文件损坏：两个 writeFile 并发 —— `open('w')`（截断）与 `write`（可能分批）交错，
 *      较短的那次写完只覆盖前半段，**长的那次残留的尾部留在文件里**，表现为
 *      "文件尾部多出一段重复残片"。
 *
 * 本锁把「同一 key（通常是文件绝对路径）」的操作串行化：
 *   - 不同 key 之间仍**并行**（不影响互不相干文件的吞吐）
 *   - 前一个操作用户者失败也不阻塞后续（错误只回传给调用方）
 *
 * 用法：
 *   await withFileLock(absPath, async () => { ... read + modify + write ... })
 */
const chains = new Map()

/**
 * 串行执行：同一 key 的 fn 一个接一个跑。
 * @param {string} key 串行键（通常为文件绝对路径）
 * @param {() => Promise<any>} fn 要串行执行的异步函数
 * @returns {Promise<any>} fn 的返回值/异常，原样透传
 */
export function withFileLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve()
  // 等前一个跑完（不管成功失败）再执行自己
  const result = prev.catch(() => {}).then(() => fn())
  // 链尾：只作"排队信号"，吞掉错误，避免污染后续
  const tail = result.then(() => {}, () => {})
  chains.set(key, tail)
  tail.then(() => {
    // 只有自己仍是链尾时才清理，防止误删后来者的排队
    if (chains.get(key) === tail) chains.delete(key)
  })
  return result
}

/** 仅供测试：当前正在排队的 key 数量 */
export function _lockSize() {
  return chains.size
}
