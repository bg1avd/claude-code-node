/**
 * message-paging.js — 会话消息分页游标
 *
 * 为什么单独成文件：这段逻辑原先内联在 `cli.js` 的 `onSessionMessages` 里，
 * 想说清"翻页会不会重复/漏"只能靠读代码猜。抽出来之后可以对着真实实现写测试。
 *
 * 背景（接入反馈 P2-3）：旧实现用 `findIndex(m => m.timestamp === before)`，
 * 只取**第一个**匹配。而 user / assistant 两条消息可能同毫秒落盘（实测差 4ms，
 * 批量导入或迁移过的旧会话可能完全相同）——一旦撞车：
 *   · 取第一条 → 与它同 ts 的消息被重复发送
 *   · 取错位置 → 中间那条被静默跳过
 * 客户端看到的是"重复"或"空洞"，而它自己没有任何办法自愈。
 *
 * 现在给客户端一个**绝对定位**的游标：`nextBefore = { index, timestamp }`，
 * 原样回传即可精确翻页；同时继续接受旧的字符串 timestamp（向后兼容）。
 */

/**
 * @param {Array<{timestamp?: string}>} all
 * @param {object} [opts]
 * @param {string|number|{index:number}|null} [opts.before] 游标（三种形式）
 * @param {number} [opts.limit=200]
 * @returns {{messages:Array, truncated:boolean, nextBefore:{index:number,timestamp:string|null}|null}}
 */
export function sliceMessagesForPage(all, { before = null, limit = 200 } = {}) {
  const list = Array.isArray(all) ? all : []
  let end = list.length

  if (before != null && before !== '') {
    if (typeof before === 'number' && Number.isFinite(before)) {
      // 数组下标（最可靠）
      end = Math.max(0, Math.min(Math.trunc(before), list.length))
    } else if (before && typeof before === 'object' && Number.isFinite(Number(before.index))) {
      // nextBefore 原样回传
      end = Math.max(0, Math.min(Math.trunc(Number(before.index)), list.length))
    } else if (typeof before === 'string') {
      // 旧客户端：按 timestamp 兜底，**保持"从第一条匹配之前开始"的原语义**。
      // 这里不再试图猜"撞车时该取哪一条"—— 两种猜法都会错一种情况
      // （取第一条会重复，取最后一条会跳过），真解是 nextBefore。
      const idx = list.findIndex(m => m?.timestamp === before)
      if (idx >= 0) end = idx
    }
  }

  const n = Math.max(1, Math.min(Number(limit) || 200, 2000))
  const start = Math.max(0, end - n)
  return {
    messages: list.slice(start, end),
    truncated: start > 0,
    nextBefore: start > 0 ? { index: start, timestamp: list[start]?.timestamp ?? null } : null,
  }
}
