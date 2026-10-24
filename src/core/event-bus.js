/**
 * event-bus.js — 内核事件总线（一个内核、N 个视图）
 *
 * 设计目标
 * ---------
 * cc-node 的主循环此前只有一个"出口"：`config.onDelta`。它被硬编码成
 * "写终端 + 推 Telegram"，于是每接一个新界面（手机 App、Web UI、编辑器）
 * 都要往主循环里再塞一段 if。事件总线把"内核发生了什么"变成一份**可订阅的事实**，
 * 各界面（Surface）只是订阅者：
 *
 *     内核（QueryEngine）
 *          │ emit()
 *          ▼
 *      EventBus ──subscribe──► 终端 REPL
 *          │        ├────────► Telegram
 *          │        └────────► local socket ──► cc-node attach
 *
 * 三条硬约定
 * ----------
 * 1. **事件带单调递增 seq**：客户端断线重连后按 seq 补齐，不必重放整场对话。
 * 2. **订阅者异常必须隔离**：某个视图崩了（渲染报错、socket 断开）绝不能把
 *    内核带崩 —— 内核是本进程唯一的真相来源。
 * 3. **stream 事件不进 replay**：逐 token 事件量级是"每回合数千条"，
 *    进环形缓冲区会把结构性事件（tool/call、turn/end）挤掉。
 *    当前回合的累积文本单独用 turn snapshot 提供。
 *
 * 事件协议（与 docs/BRIDGE_MIGRATION.md 阶段 2 一致）
 * ---------------------------------------------------
 *   turn/start        { reqId, source }
 *   turn/snapshot     { reqId, text, reasoning }        // 仅 attach 时补发
 *   stream            { reqId, kind: 'text'|'reasoning', text }
 *   tool/call         { reqId, name, input }
 *   tool/result       { reqId, name, ok, summary }
 *   confirm/request   { reqId, id, question, snippet }
 *   confirm/resolved  { reqId, id, answer, by }
 *   turn/end          { reqId, text, turns, aborted }
 *   status            { state: 'running'|'idle' }
 *   notice            { text }
 */

/** 不进 replay 的"高频"事件类型 —— 只存结构性事件 */
const VOLATILE_TYPES = new Set(['stream'])

/** 单条事件里可能导致循环引用/超大体积的字段，统一截断 */
function truncate(value, max) {
  const s = typeof value === 'string' ? value : safeJson(value)
  return s.length > max ? s.slice(0, max) + `…（已截断，共 ${s.length} 字符）` : s
}

function safeJson(v) {
  try { return JSON.stringify(v) ?? '' } catch { return String(v) }
}

export class EventBus {
  /**
   * @param {object} [opts]
   * @param {number} [opts.replaySize=200] 结构性事件环形缓冲条数（断线补齐用）
   * @param {number} [opts.maxListeners=64] 订阅者上限（防洪泛 attach）
   */
  constructor({ replaySize = 200, maxListeners = 64, historySize = 20 } = {}) {
    this.seq = 0
    this.replay = []
    this.replaySize = Math.max(1, replaySize)
    this.maxListeners = maxListeners
    this.subs = new Set()

    // 最近若干回合的完整原文（供断线重连后"补正文"）。
    // 为什么不能靠 replay：stream 事件不进环形缓冲（量太大），
    // 所以 replay 里只有结构性事件。客户端重连若想看到"上一轮说了什么"，
    // 需要这份按回合归档的正文。
    this.historySize = Math.max(0, historySize)
    this.turns = []

    // 当前回合快照（供 attach 中途接入的客户端"看到正在生成的内容"）
    this.currentTurn = null   // { reqId, text, reasoning, source }
    // 统计（/status 与排障用）
    this.counts = Object.create(null)
  }

  /**
   * 发布事件。
   * @param {string} type 事件类型（见文件头协议）
   * @param {object} [payload]
   * @returns {{type:string, seq:number, ts:number}}
   */
  emit(type, payload = {}) {
    if (!type || typeof type !== 'string') throw new Error('EventBus.emit: type 必须是非空字符串')

    // 顺序至关重要：先铺 payload，再用内核权威字段覆盖。
    // 若反过来写，工具参数里恰好带 type/seq 字段（比如某个工具返回体）就会篡改事件协议。
    const ev = { ...payload, type, seq: ++this.seq, ts: Date.now() }
    this.counts[type] = (this.counts[type] || 0) + 1

    // 维护当前回合快照
    if (type === 'turn/start') {
      this.currentTurn = { reqId: ev.reqId, text: '', reasoning: '', source: ev.source || null }
    } else if (type === 'stream' && this.currentTurn && this.currentTurn.reqId === ev.reqId) {
      if (ev.kind === 'reasoning') this.currentTurn.reasoning += ev.text || ''
      else this.currentTurn.text += ev.text || ''
    } else if (type === 'turn/end') {
      // 归档本回合原文（先归档、后清快照 —— 顺序反了就拿不到 reasoning）
      if (this.historySize > 0) {
        this.turns.push({
          reqId: ev.reqId,
          text: ev.text || '',
          reasoning: this.currentTurn?.reasoning || '',
          turns: ev.turns ?? null,
          aborted: !!ev.aborted,
          error: ev.error || null,
          ts: ev.ts,
        })
        if (this.turns.length > this.historySize) this.turns.shift()
      }
      this.currentTurn = null
    }

    // 结构性事件进环形缓冲，供断线客户端按 seq 补齐
    if (!VOLATILE_TYPES.has(type)) {
      this.replay.push(ev)
      if (this.replay.length > this.replaySize) this.replay.shift()
    }

    // 广播：订阅者异常隔离，绝不影响内核
    for (const sub of this.subs) {
      if (sub.closed) continue
      try {
        sub.fn(ev)
      } catch (e) {
        // 视图渲染失败只应毁掉它自己；记一次后继续广播给其他视图。
        sub.errors = (sub.errors || 0) + 1
        sub.lastError = e?.message || String(e)
        if (sub.onError) { try { sub.onError(e, ev) } catch { /* 忽略 */ } }
      }
    }

    return { type: ev.type, seq: ev.seq, ts: ev.ts }
  }

  /**
   * 订阅事件。
   *
   * @param {(ev:object)=>void} fn 事件回调（同步执行，请勿在其中做重活）
   * @param {object} [opts]
   * @param {number} [opts.sinceSeq=0] 只补发 seq 大于该值的历史结构性事件（断线补齐）
   * @param {(e:Error, ev:object)=>void} [opts.onError] 回调异常时的旁路通知
   * @param {string} [opts.name] 订阅者名称（排障用）
   * @returns {() => void} 取消订阅函数
   */
  subscribe(fn, { sinceSeq = 0, onError = null, name = 'anonymous' } = {}) {
    if (typeof fn !== 'function') throw new Error('EventBus.subscribe: fn 必须是函数')
    if (this.subs.size >= this.maxListeners) {
      throw new Error(`EventBus: 订阅者已达上限 ${this.maxListeners}（疑似 attach 泄漏）`)
    }

    // 语义：补齐"这次连接之前发生、但客户端还没见过"的结构性事件。
    // 注意顺序 —— 必须先把历史同步发完，再挂进 subs，否则会与实时事件交错。
    if (sinceSeq > 0) {
      for (const ev of this.replay) {
        if (ev.seq > sinceSeq) {
          try { fn(ev) } catch { /* 补齐失败不阻断订阅 */ }
        }
      }
    }

    // 中途接入的客户端：如果此刻有回合在跑，补一份当前累积文本快照
    if (this.currentTurn) {
      try {
        fn({
          type: 'turn/snapshot',
          seq: this.seq,
          ts: Date.now(),
          reqId: this.currentTurn.reqId,
          text: this.currentTurn.text,
          reasoning: this.currentTurn.reasoning,
        })
      } catch { /* 忽略 */ }
    }

    const sub = { fn, onError, name, closed: false, errors: 0, lastError: null }
    this.subs.add(sub)

    return () => {
      sub.closed = true
      this.subs.delete(sub)
    }
  }

  /** 最近一条结构性事件的 seq（客户端重连时带上它） */
  get lastSeq() { return this.seq }

  /**
   * 清空「最近回合正文」归档。
   *
   * 什么时候必须调用：**切换 / 新建会话**之后。
   * turn_history 的全部意义是"补这个会话最近说了什么"，如果不清，
   * 移动端切到新会话后拉历史会拿到上一个会话的正文 —— 上下文串台，
   * 比没有历史更糟。
   */
  clearTurnHistory() {
    this.turns = []
    this.currentTurn = null
  }

  /**
   * 取最近若干回合的原文（断线重连/主动补正文用）。
   * @param {number} [limit=5] 最多返回几条（从旧到新）
   */
  recentTurns(limit = 5) {
    const n = Math.max(0, Math.min(Number(limit) || 0, this.turns.length))
    return this.turns.slice(this.turns.length - n)
  }

  /** 排障快照 */
  stats() {
    return {
      seq: this.seq,
      subscribers: this.subs.size,
      replaySize: this.replay.length,
      history: this.turns.length,
      running: !!this.currentTurn,
      counts: { ...this.counts },
    }
  }
}

/** 生成回合 ID（够短、够唯一，日志里可读） */
export function newReqId(prefix = 'r') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 工具结果摘要：给远程视图看的短文本，避免把整个文件内容灌进事件流 */
export function summarizeToolResult(content, max = 400) {
  return truncate(content == null ? '' : content, max)
}
