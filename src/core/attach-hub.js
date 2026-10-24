/**
 * attach-hub.js — local socket 上的「多视图接入」中枢
 *
 * 定位
 * ----
 * cc-node 内核只认一件事实：**发生了什么**（由 EventBus 广播）。
 * 这个文件负责把事件分发给所有通过 socket 接进来的视图（cc-node attach、
 * 手机 App 的桥、Web UI），并接收它们的输入/中断/确认。
 *
 * 它与终端 REPL、Telegram 是**平级**关系，不是上下级：
 *
 *        ┌──────── 终端 REPL（用户在终端里启动的那个）
 *  内核 ─┼──────── Telegram
 *        └──────── AttachHub ──► socket 客户端 1..N
 *
 * 三条约束（来自 docs/BRIDGE_MIGRATION.md）
 * ------------------------------------------
 * 1. **回合串行**：同一时刻只有一个回合。忙时到达的输入排队，不并发。
 * 2. **先答先赢**：一条确认请求只有一个正确答案；谁先应答谁生效，
 *    其他视图通过 confirm/resolved 得知结果（避免两个界面各自"通过"）。
 * 3. **视图崩了不能带崩内核**：写 socket 失败就摘掉这个客户端，仅此而已。
 *
 * 客户端 → 服务端协议
 * -------------------
 *   { type:'attach', role:'viewer'|'controller', sinceSeq?:number }
 *   { type:'input',  reqId?:string, text:string, images?:string[] }
 *   { type:'abort' }
 *   { type:'confirm', id:string, answer:'y'|'n'|'a' }
 *   { type:'session_list' }
 *   { type:'ping' }
 *   { type:'user_input', text }          // 阶段 1 兼容
 *
 * 服务端 → 客户端：EventBus 事件原样转发（NDJSON），另有
 *   { type:'attached', pid, running, session }
 *   { type:'sessions', list }
 *   { type:'error', text }
 *   { type:'queued', position }
 */

import { EventBus } from '../core/event-bus.js'

/** stream 事件合批窗口（毫秒）—— 逐 token 直发会把 socket 打爆 */
const STREAM_FLUSH_MS = 16
/** 队列上限：单人产品够用，防止远程刷屏把内核拖死 */
const MAX_QUEUE = 20
/** 单行协议上限 */
const MAX_LINE = 1024 * 1024

export class AttachHub {
  /**
   * @param {object} opts
   * @param {EventBus} opts.bus
   * @param {object} opts.engine
   * @param {object} [opts.sessionManager]
   * @param {(text:string, images:string[])=>Promise<any>} opts.onSubmit 提交用户输入的入口
   * @param {()=>void} [opts.onAbort]
   * @param {(msg:string)=>void} [opts.log]
   */
  constructor({ bus, engine, sessionManager, onSubmit, onAbort, onLoadSession, log = () => {} }) {
    this.bus = bus
    this.engine = engine
    this.sessionManager = sessionManager
    this.onSubmit = onSubmit
    this.onAbort = onAbort
    this.onLoadSession = onLoadSession || null
    this.log = log

    /** @type {Set<{socket,role,seq,closed,buf,flushTimer}>} */
    this.clients = new Set()
    /** 排队中的输入 */
    this.queue = []
    /** 确认请求注册表：confirmId → { resolve, timer } */
    this._pendingConfirms = new Map()
    this._disposed = false

    this._unsub = this.bus.subscribe((ev) => this._onBusEvent(ev), { name: 'attach-hub' })
  }

  // ----------------------------------------------------------
  // 客户端生命周期
  // ----------------------------------------------------------

  /** 接管一个新的 socket 连接 */
  addClient(socket) {
    const client = {
      socket,
      role: 'viewer',        // 默认只读：未 attach 前不给任何特权
      attached: false,
      seq: 0,
      buffer: '',
      streamBuf: [],
      flushTimer: null,
      closed: false,
    }
    this.clients.add(client)

    socket.on('data', (data) => this._onData(client, data))
    socket.on('error', () => this.removeClient(client))
    socket.on('close', () => this.removeClient(client))

    return client
  }

  removeClient(client) {
    if (!client || client.closed) return
    client.closed = true
    if (client.flushTimer) { clearTimeout(client.flushTimer); client.flushTimer = null }
    this.clients.delete(client)
    try { client.socket.destroy() } catch {}
    this.log(`[attach] 客户端断开（剩余 ${this.clients.size}）`)
  }

  /** 是否有可操作的视图在线（决定远程确认是否接管） */
  hasController() {
    for (const c of this.clients) if (c.attached && c.role === 'controller' && !c.closed) return true
    return false
  }

  dispose() {
    this._disposed = true
    this._unsub?.()
    for (const c of [...this.clients]) this.removeClient(c)
    for (const [, p] of this._pendingConfirms) { clearTimeout(p.timer); p.resolve(null) }
    this._pendingConfirms.clear()
  }

  // ----------------------------------------------------------
  // 协议：客户端 → 服务端
  // ----------------------------------------------------------

  _onData(client, data) {
    client.buffer += data.toString()
    if (client.buffer.length > MAX_LINE) {
      // 无换行的超长数据 → 协议异常，断开即可（绝不无界累积）
      this._send(client, { type: 'error', text: `单行超过 ${MAX_LINE} 字符，连接已关闭` })
      this.removeClient(client)
      return
    }
    const lines = client.buffer.split('\n')
    client.buffer = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      this._handleLine(client, line)
    }
  }

  _handleLine(client, line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      this._send(client, { type: 'error', text: '消息不是合法 JSON' })
      return
    }
    if (!msg || typeof msg.type !== 'string') {
      this._send(client, { type: 'error', text: '消息缺少 type 字段' })
      return
    }

    switch (msg.type) {
      case 'ping':
        this._send(client, { type: 'pong', pid: process.pid })
        return

      case 'attach':
        this._handleAttach(client, msg)
        return

      case 'session_list':
        this._sendSessions(client)
        return

      // 只读操作：viewer 也能补正文（它不需要任何特权）
      case 'turn_history':
        this._send(client, {
          type: 'turn/history',
          turns: this.bus.recentTurns(msg.limit ?? 5),
        })
        return

      // 阶段 1 兼容：老客户端（cc-notify / 已有桥）发 user_input 时**不会** attach，
      // 也不认事件流。它期待的是 {type:'reply', text}。这条路径必须原样保留，
      // 否则升级内核会静默打断所有既有接入方。
      case 'user_input':
        client.legacy = true
        this._handleInput(client, msg.text, msg.images)
        return
    }

    // 以下操作需要 controller 角色
    if (!client.attached) {
      this._send(client, { type: 'error', text: '请先发送 {type:"attach", role:"controller"}' })
      return
    }
    if (client.role !== 'controller') {
      this._send(client, { type: 'error', text: '当前为只读视图（viewer），不能发送输入/中断/确认' })
      return
    }

    switch (msg.type) {
      case 'input':
        this._handleInput(client, msg.text, msg.images)
        return
      case 'user_input':   // 阶段 1 兼容：一问一答，回复走 turn/end
        this._handleInput(client, msg.text, msg.images)
        return
      case 'abort':
        this.onAbort?.()
        this._send(client, { type: 'notice', text: '已请求中断当前回合' })
        return
      case 'confirm':
        this._handleConfirm(client, msg)
        return
      case 'session_load':
        this._handleSessionLoad(client, msg)
        return
      default:
        this._send(client, { type: 'error', text: `未知消息类型: ${msg.type}` })
    }
  }

  _handleAttach(client, msg) {
    const role = msg.role === 'controller' ? 'controller' : 'viewer'
    client.role = role
    client.attached = true
    client.legacy = false   // 同一连接先走 user_input 后又 attach：切到事件流
    client.seq = Number(msg.sinceSeq) || 0

    this._send(client, {
      type: 'attached',
      pid: process.pid,
      role,
      running: !!this.engine?.state?.isRunning,
      session: this.sessionManager?.currentSession?.id || null,
      lastSeq: this.bus.lastSeq,
      historyAvailable: this.bus.turns.length,
    })

    // 断线补齐：把客户端没见过的结构性事件发过去。
    // 注意 sinceSeq=0 时不补历史——新接入的视图不该被几百条旧事件淹没，
    // 它要的是"从现在开始看"，以及（若回合在跑）一份当前进度快照。
    if (client.seq > 0) {
      const oldest = this.bus.replay[0]
      if (oldest && client.seq < oldest.seq - 1) {
        // 明确告知缺口，而不是让客户端以为自己什么都收到了
        this._send(client, {
          type: 'notice',
          text: `事件序号已滚出缓冲（请求从 ${client.seq} 补，最老只剩 ${oldest.seq}）：` +
                `结构性事件只能补可用部分；正文请用 turn_history 拉取最近回合`,
        })
      }
      for (const ev of this.bus.replay) {
        if (ev.seq > client.seq) this._send(client, ev)
      }
    }
    if (this.bus.currentTurn) {
      this._send(client, {
        type: 'turn/snapshot',
        seq: this.bus.seq,
        reqId: this.bus.currentTurn.reqId,
        text: this.bus.currentTurn.text,
        reasoning: this.bus.currentTurn.reasoning,
      })
    }
    this.log(`[attach] ${role} 接入（客户端数 ${this.clients.size}）`)
  }

  _handleInput(client, text, images) {
    if (!text || typeof text !== 'string') {
      this._send(client, { type: 'error', text: 'input 缺少 text' })
      return
    }
    // 回合串行：忙就排队，空闲立刻执行
    if (this._isBusy() || this.queue.length > 0) {
      if (this.queue.length >= MAX_QUEUE) {
        this._send(client, { type: 'error', text: `队列已满（${MAX_QUEUE} 条），请稍后再发` })
        return
      }
      this.queue.push({ text, images: Array.isArray(images) ? images : [] })
      this._send(client, { type: 'queued', position: this.queue.length })
      return
    }
    this._runInput(text, images)
  }

  async _runInput(text, images) {
    try {
      await this.onSubmit(text, Array.isArray(images) ? images : [])
    } catch (e) {
      for (const c of this.clients) {
        this._send(c, { type: 'error', text: `执行失败: ${e?.message || e}` })
      }
    }
  }

  _handleConfirm(client, msg) {
    const id = msg.id
    const answer = msg.answer === 'a' ? 'a' : (msg.answer === 'y' ? 'y' : 'n')
    const ok = this.answerConfirm(id, answer === 'n' ? false : true, `attach:${client.role}`, answer)
    if (!ok) this._send(client, { type: 'error', text: `没有待确认的请求: ${id}` })
  }

  /**
   * 切换会话（controller 专属）。
   *
   * ⚠️ 这会改变**所有视图**的上下文 —— 终端那边也跟着换。
   * 这是"一个内核、一份上下文"的必然结果，不是缺陷。
   * 因此切换成功后用 bus 广播 session/loaded，让每个视图都能刷新自己的显示。
   */
  async _handleSessionLoad(client, msg) {
    if (!this.onLoadSession) {
      this._send(client, { type: 'error', text: '本内核不支持切换会话' })
      return
    }
    const sessionId = msg.sessionId || msg.id
    if (!sessionId) {
      this._send(client, { type: 'error', text: 'session_load 缺少 sessionId' })
      return
    }
    if (this._isBusy()) {
      this._send(client, { type: 'error', text: '当前有回合在跑，先 abort 再切换会话' })
      return
    }
    try {
      const r = await this.onLoadSession(String(sessionId))
      if (!r || !r.ok) {
        this._send(client, { type: 'error', text: r?.error || '切换会话失败' })
        return
      }
      this.bus.emit('session/loaded', { id: r.id, title: r.title, cwd: r.cwd || null })
      this.bus.emit('notice', { text: `会话已切换：${r.title || r.id}` })
    } catch (e) {
      this._send(client, { type: 'error', text: `切换会话失败: ${e?.message || e}` })
    }
  }

  /**
   * 把一段文本回显给在线视图（`/命令` 的输出）。
   *
   * 为什么不走 EventBus：命令输出是"对某次请求的应答"，不是内核的全局事实。
   * 进 replay 的话，客户端重连会被一堆旧命令输出淹掉。
   */
  echo(text) {
    const body = String(text ?? '')
    if (!body) return
    for (const c of this.clients) {
      if (c.closed) continue
      if (c.legacy) this._send(c, { type: 'reply', text: body })
      else if (c.attached) this._send(c, { type: 'command/output', text: body })
    }
  }

  // ----------------------------------------------------------
  // 确认：先答先赢
  // ----------------------------------------------------------
  /**
   * 等待某个确认请求的应答（由宿主 onConfirmTool 调用）。
   * @param {string} confirmId
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=60000] 超时 → resolve(null)，调用方据此走自己的兜底
   * @returns {Promise<{answer:boolean, by:string, raw:string}|null>}
   */
  waitConfirm(confirmId, { timeoutMs = 60000 } = {}) {
    if (!confirmId) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingConfirms.delete(confirmId)
        resolve(null)
      }, timeoutMs)
      this._pendingConfirms.set(confirmId, { resolve, timer })
    })
  }

  /**
   * 应答一个确认请求。只有第一个应答生效（先答先赢）。
   * @returns {boolean} 是否命中一个待决请求
   */
  answerConfirm(confirmId, answer, by, raw = answer ? 'y' : 'n') {
    const pending = this._pendingConfirms.get(confirmId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this._pendingConfirms.delete(confirmId)
    pending.resolve({ answer: !!answer, by: by || null, raw })
    return true
  }

  // ----------------------------------------------------------
  // 事件广播
  // ----------------------------------------------------------

  _onBusEvent(ev) {
    if (this._disposed) return

    for (const client of this.clients) {
      if (client.closed) continue

      // 阶段 1 老客户端：只认 {type:'reply'}，别把事件流灌给它
      if (client.legacy) {
        if (ev.type === 'turn/end') {
          this._send(client, ev.error
            ? { type: 'error', text: ev.error }
            : { type: 'reply', text: ev.text })
        }
        continue
      }

      if (!client.attached) continue
      if (ev.type === 'stream') {
        client.streamBuf.push(ev)
        this._scheduleFlush(client)
      } else {
        // 顺序至关重要：结构性事件（tool/call、turn/end…）之前，必须先把
        // 已缓冲的增量吐出去。否则客户端会先看到"回合结束"、后看到正文，
        // 时间线整个错乱（实测：合批延迟 16ms 足以让 stream 排在 turn/end 之后）。
        this._flushStream(client)
        this._send(client, ev)
      }
    }

    // 回合结束 → 消化排队输入（在广播之后执行，让视图先看到结束态）
    if (ev.type === 'turn/end') this._drainQueue()
  }

  _scheduleFlush(client) {
    if (client.flushTimer) return
    client.flushTimer = setTimeout(() => {
      client.flushTimer = null
      if (client.closed) return
      this._flushStream(client)
    }, STREAM_FLUSH_MS)
  }

  /** 立即把该客户端缓冲的 stream 增量合并发出（幂等） */
  _flushStream(client) {
    if (client.flushTimer) { clearTimeout(client.flushTimer); client.flushTimer = null }
    const buf = client.streamBuf
    client.streamBuf = []
    if (!buf.length) return

    // 相邻同 kind 的增量合并成一条，seq 取最后一条（客户端据此判断新鲜度）
    const merged = []
    for (const ev of buf) {
      const last = merged[merged.length - 1]
      if (last && last.kind === ev.kind && last.reqId === ev.reqId) {
        last.text += ev.text || ''
        last.seq = ev.seq
        last.ts = ev.ts
      } else {
        merged.push({ type: 'stream', kind: ev.kind, reqId: ev.reqId, seq: ev.seq, ts: ev.ts, text: ev.text || '' })
      }
    }
    for (const ev of merged) this._send(client, ev)
  }

  _drainQueue() {
    if (!this.queue.length) return
    if (this._isBusy()) return
    const next = this.queue.shift()
    // 让出事件循环：turn/end 的广播要先把"结束态"送到视图，再开下一回合
    setTimeout(() => {
      if (this._isBusy()) { this.queue.unshift(next); return }
      this._runInput(next.text, next.images)
    }, 0)
  }

  _isBusy() {
    // 忙有两种来源：内核正在跑，或排队输入正在提交中
    return !!this.engine?.state?.isRunning
  }

  // ----------------------------------------------------------
  // 工具
  // ----------------------------------------------------------

  _sendSessions(client) {
    Promise.resolve()
      .then(() => this.sessionManager?.list?.() || [])
      .then((list) => this._send(client, { type: 'sessions', list: Array.isArray(list) ? list : [] }))
      .catch((e) => this._send(client, { type: 'error', text: `读取会话列表失败: ${e.message}` }))
  }

  _send(client, obj) {
    if (!client || client.closed) return
    try {
      client.socket.write(JSON.stringify(obj) + '\n')
    } catch {
      // 视图写失败 = 这个视图没了；摘掉它，内核继续跑
      this.removeClient(client)
    }
  }

  stats() {
    return {
      clients: this.clients.size,
      controllers: [...this.clients].filter(c => c.attached && c.role === 'controller').length,
      queued: this.queue.length,
      pendingConfirms: this._pendingConfirms.size,
    }
  }
}
