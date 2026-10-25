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
 *   { type:'attach', role:'viewer'|'controller', sinceSeq?:number, confirmable?:boolean }
 *   { type:'input',  reqId?:string, text:string, images?:string[] }
 *   { type:'abort' }
 *   { type:'confirm', id:string, answer:'y'|'n'|'a' }
 *   { type:'session_list' }
 *   { type:'session_load', sessionId:string }
 *   { type:'session_new',  title?:string }
 *   { type:'session_messages', sessionId?:string, limit?:number, before?:string }
 *   { type:'turn_history', limit?:number }
 *   { type:'scheduler_list' }
 *   { type:'command_list' }
 *   { type:'ping' }
 *   { type:'user_input', text }          // 阶段 1 兼容
 *
 * 服务端 → 客户端：EventBus 事件原样转发（NDJSON），另有
 *   { type:'attached', pid, role, running, session, sessionTitle, cwd, model,
 *     permissionMode, confirmable, lastSeq, historyAvailable, replaySize, maxLine, queued }
 *   { type:'sessions', list }
 *   { type:'session/messages', sessionId, messages, total, truncated, nextBefore }
 *   { type:'scheduler/list', available, tasks }
 *   { type:'commands', supported, list }
 *   { type:'command/output', text, reqId, done }
 *   { type:'error', text }
 *   { type:'queued', position, clientReqId }
 */

import { EventBus } from './event-bus.js'

/** stream 事件合批窗口（毫秒）—— 逐 token 直发会把 socket 打爆 */
const STREAM_FLUSH_MS = 16
/** 队列上限：单人产品够用，防止远程刷屏把内核拖死 */
const MAX_QUEUE = 20
/**
 * 单行协议上限。
 *
 * 为什么是 8MB 而不是 1MB：图片只能以 base64 data URL 内嵌（手机/远端的模型服务
 * 访问不到 127.0.0.1），base64 会膨胀 33%。1MB 上限等于原图只剩 ~750KB，
 * 一张截图或两张图同时发就会撞线 —— 而撞线的旧行为是**直接断连接**，
 * 客户端只能重连重发，还猜不到原因。这里与 cli.js 的 IPC_BUFFER_MAX 对齐。
 */
const MAX_LINE = 8 * 1024 * 1024
/**
 * 单个视图的积压上限。
 * socket.write() 返回 false 表示对端不读了；继续无限堆积会把内核内存拖爆。
 * 超过这个量就认定该视图已死，摘掉它（内核不受影响）。
 */
const MAX_OUTBUF = 8 * 1024 * 1024
/** 排队输入撞上"宿主又忙了"时的重试间隔 */
const RETRY_MS = 300
/**
 * 重试上限（≈ 10 分钟）。
 *
 * 为什么必须有上限：无上限的重试是"排队死信"的镜像问题 —— 消息既不执行、
 * 也不报错，客户端只能干等（正是审计 P0-1 那一类事故）。到了上限就把队列
 * 里的消息逐条回一个 error，让用户知道"要重发"，而不是永远安静。
 *
 * 10 分钟的依据：单回合跑十几分钟是可能的（长任务），但超过这个量级基本是
 * 内核卡住了，继续等没有意义。
 */
const RETRY_MAX_TRIES = Math.ceil((10 * 60 * 1000) / RETRY_MS)

export class AttachHub {
  /**
   * @param {object} opts
   * @param {EventBus} opts.bus
   * @param {object} opts.engine
   * @param {object} [opts.sessionManager]
   * @param {(text:string, images:string[], reqId?:string)=>Promise<any>} opts.onSubmit 提交用户输入的入口
   * @param {()=>void} [opts.onAbort]
   * @param {(id:string)=>Promise<{ok:boolean,id?:string,title?:string,cwd?:string,error?:string}>} [opts.onLoadSession]
   * @param {(title?:string)=>Promise<{ok:boolean,...}>} [opts.onNewSession]
   * @param {(q:{sessionId?:string,limit?:number,before?:string})=>Promise<object>} [opts.onSessionMessages]
   * @param {()=>object} [opts.getContext] 当前运行上下文：cwd / model / permissionMode / sessionTitle / sessionId
   * @param {()=>object[]} [opts.getSchedules] 定时任务列表（供 scheduler_list）
   * @param {()=>object[]} [opts.getCommands] 命令清单（供 command_list，接入反馈 P2-1）
   * @param {(msg:string)=>void} [opts.log]
   */
  constructor({
    bus, engine, sessionManager, onSubmit, onAbort, onLoadSession,
    onNewSession, onSessionMessages, getContext, getSchedules, getCommands, log = () => {},
  }) {
    this.bus = bus
    this.engine = engine
    this.sessionManager = sessionManager
    this.onSubmit = onSubmit
    this.onAbort = onAbort
    this.onLoadSession = onLoadSession || null
    this.onNewSession = onNewSession || null
    this.onSessionMessages = onSessionMessages || null
    this.getContext = getContext || (() => ({}))
    this.getSchedules = getSchedules || null
    this.getCommands = getCommands || null
    this.log = log

    /** @type {Set<object>} */
    this.clients = new Set()
    /** 排队中的输入 */
    this.queue = []
    /** 确认请求注册表：confirmId → { resolve, timer } */
    this._pendingConfirms = new Map()
    this._drainTimer = null
    this._retryTimer = null
    /** 连续重试次数（成功消化一条就归零，见 _scheduleRetry） */
    this._retryTries = 0
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
      legacy: false,
      confirmable: true,     // 无 UI 的桥可显式声明 false（别把确认派给我）
      seq: 0,
      buffer: '',
      discarding: false,     // 超长行丢弃中（等下一个换行再恢复）
      streamBuf: [],
      flushTimer: null,
      outBuf: [],            // 背压期间积压的行
      outBytes: 0,
      backlogged: false,
      flushing: false,
      closed: false,
    }
    this.clients.add(client)

    socket.on('data', (data) => this._onData(client, data))
    socket.on('drain', () => this._onDrain(client))
    socket.on('error', () => this.removeClient(client))
    socket.on('close', () => this.removeClient(client))

    return client
  }

  removeClient(client) {
    if (!client || client.closed) return
    client.closed = true
    if (client.flushTimer) { clearTimeout(client.flushTimer); client.flushTimer = null }
    client.outBuf = []
    client.outBytes = 0
    this.clients.delete(client)
    try { client.socket.destroy() } catch {}
    this.log(`[attach] 客户端断开（剩余 ${this.clients.size}）`)
  }

  /** 是否有可操作的视图在线 */
  hasController() {
    for (const c of this.clients) if (c.attached && c.role === 'controller' && !c.closed) return true
    return false
  }

  /**
   * 是否有**愿意接收确认请求**的视图在线。
   *
   * 与 hasController() 分开的原因（审计 P1-2）：
   * 手机端的桥是常驻守护进程，"有 controller 在线"恒为真，但它可能根本没有 UI
   * 能把确认推给用户。旧逻辑因此让每个工具确认都先空等 60 秒，然后落到终端
   * rl.question（无超时）—— 人不在电脑前就永久挂起，还会吃掉用户回座后的第一条输入。
   * 桥只要在 attach 时声明 confirmable:false，就不会再被算进来。
   */
  hasConfirmController() {
    for (const c of this.clients) {
      if (c.attached && !c.closed && c.role === 'controller' && c.confirmable !== false) return true
    }
    return false
  }

  dispose() {
    this._disposed = true
    this._unsub?.()
    if (this._drainTimer) { clearTimeout(this._drainTimer); this._drainTimer = null }
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    for (const c of [...this.clients]) this.removeClient(c)
    for (const [, p] of this._pendingConfirms) { clearTimeout(p.timer); p.resolve(null) }
    this._pendingConfirms.clear()
  }

  // ----------------------------------------------------------
  // 协议：客户端 → 服务端
  // ----------------------------------------------------------

  /**
   * 收数据：按行切分。
   *
   * 关键改动（审计 P0-2）：超长行**只丢该行、保留连接**。
   * 旧实现是"buffer 超限就断连接"，而 base64 图片很容易超过 1MB，
   * 结果是一张截图就让手机端掉线 —— 客户端只看到 socket closed，
   * 既不知道原因也不知道该重发什么。
   */
  _onData(client, data) {
    let text = data.toString()

    // 丢弃模式：上一块数据里有一行超长且还没见到换行，继续扔到下一个换行为止
    if (client.discarding) {
      const nl = text.indexOf('\n')
      if (nl < 0) return              // 整块都属于那条被丢弃的超长行
      client.discarding = false
      text = text.slice(nl + 1)
      if (!text) return
    }

    client.buffer += text

    let nl
    while ((nl = client.buffer.indexOf('\n')) >= 0) {
      const line = client.buffer.slice(0, nl)
      client.buffer = client.buffer.slice(nl + 1)
      if (!line.trim()) continue
      if (line.length > MAX_LINE) {
        this._send(client, {
          type: 'error',
          text: `单行超过 ${MAX_LINE} 字符，已丢弃该行（连接保留）`,
          code: 'LINE_TOO_LONG',
          dropped: line.length,
        })
        continue
      }
      this._handleLine(client, line)
    }

    // 还没有换行就已经超限 → 这一行注定超长，丢弃模式开始（绝不无界累积）
    if (client.buffer.length > MAX_LINE) {
      const dropped = client.buffer.length
      client.buffer = ''
      client.discarding = true
      this._send(client, {
        type: 'error',
        text: `单行超过 ${MAX_LINE} 字符，已丢弃该行（连接保留）`,
        code: 'LINE_TOO_LONG',
        dropped,
      })
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

      // 以下都是只读操作：viewer 也能用（不需要任何特权）
      case 'turn_history':
        this._send(client, {
          type: 'turn/history',
          turns: this.bus.recentTurns(msg.limit ?? 5),
        })
        return

      case 'session_messages':
        this._sendSessionMessages(client, msg)
        return

      case 'scheduler_list':
        this._sendSchedules(client, msg)
        return

      // 命令清单（接入反馈 P2-1）：接入方不该去读源码里的 HELP_TEXT 再硬编码，
      // 内核加一条命令就要跟着发一次版。这里由宿主给出机器可读清单。
      case 'command_list':
        this._sendCommands(client)
        return

      // 阶段 1 兼容：老客户端（cc-notify / 已有桥）发 user_input 时**不会** attach，
      // 也不认事件流。它期待的是 {type:'reply', text}。这条路径必须原样保留，
      // 否则升级内核会静默打断所有既有接入方。
      //
      // 但已 attach 的连接**绝不能**因此被降级（审计 P0-3）：
      // 一旦 client.legacy=true，_onBusEvent 会吞掉它所有的事件流，只在
      // turn/end 时回一条 reply —— 表现为"偶发无流式"，几乎无法排查。
      // 所以这里 break 落到下面的角色检查，把 user_input 当作 input 处理。
      case 'user_input':
        if (client.attached) break
        client.legacy = true
        this._handleInput(client, msg.text, msg.images, msg.reqId)
        return
    }

    // 以下操作需要 controller 角色
    if (!client.attached) {
      this._send(client, { type: 'error', text: '请先发送 {type:"attach", role:"controller"}' })
      return
    }
    if (client.role !== 'controller') {
      this._send(client, {
        type: 'error',
        text: '当前为只读视图（viewer），不能发送输入/中断/确认/切换或新建会话',
      })
      return
    }

    switch (msg.type) {
      case 'input':
      case 'user_input':   // 已 attach 的连接用老格式发东西：按 input 处理，不降级
        this._handleInput(client, msg.text, msg.images, msg.reqId)
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
      case 'session_new':
        this._handleSessionNew(client, msg)
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
    client.confirmable = msg.confirmable !== false
    client.seq = Number(msg.sinceSeq) || 0

    const ctx = this._context()
    this._send(client, {
      type: 'attached',
      pid: process.pid,
      role,
      running: !!this.engine?.state?.isRunning,
      // v4.1.1：把"我现在在跟谁说话"必需的信息一次给全（审计 P1-4）。
      // 迁移后 cwd 完全由内核决定（不再由桥的 config 控制），客户端没法自己推断。
      session: ctx.sessionId,
      sessionTitle: ctx.sessionTitle,
      cwd: ctx.cwd,
      model: ctx.model,
      permissionMode: ctx.permissionMode,
      confirmable: client.confirmable,
      lastSeq: this.bus.lastSeq,
      historyAvailable: this.bus.turns.length,
      replaySize: this.bus.replaySize,
      maxLine: MAX_LINE,
      queued: this.queue.length,
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
                `结构性事件只能补可用部分；正文请用 turn_history / session_messages 拉取`,
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

  _context() {
    let c = {}
    try { c = this.getContext() || {} } catch { c = {} }
    return {
      sessionId: c.sessionId ?? (this.sessionManager?.currentSession?.id || null),
      sessionTitle: c.sessionTitle ?? (this.sessionManager?.currentSession?.title || null),
      cwd: c.cwd ?? null,
      model: c.model ?? null,
      permissionMode: c.permissionMode ?? null,
    }
  }

  _handleInput(client, text, images, reqId) {
    if (!text || typeof text !== 'string') {
      this._send(client, { type: 'error', text: 'input 缺少 text' })
      return
    }
    const clientReqId = typeof reqId === 'string' && reqId ? reqId : null

    /**
     * 斜杠命令不参与回合排队（接入反馈 P1）。
     *
     * Telegram 侧的命令是在**忙检查之前**分流的（`_handleCommand` 先跑），
     * 所以 AI 正在生成时手机发 `/status` 立即有回复，而 attach 侧却要等整个
     * 回合跑完 —— 同一个内核两种行为，用户感受是"看着正在思考，什么命令都
     * 发不进去"。命令本身几乎不耗时（读状态 / 切配置 / 中止回合），排队
     * 没有任何收益。
     *
     * 但"哪条命令能在忙时执行"属于**内核的命令语义**，不该硬编码在 hub 里，
     * 否则以后加命令要改两处、迟早漂移。所以这里只做"命令不排队"这一件事，
     * 真正的安全边界交给宿主（`processInputLine` 里的忙时白名单）。
     */
    const isCommand = /^\s*\//.test(text)

    // 回合串行：忙就排队，空闲立刻执行（命令除外，见上）
    if (!isCommand && (this._isBusy() || this.queue.length > 0)) {
      if (this.queue.length >= MAX_QUEUE) {
        this._send(client, { type: 'error', text: `队列已满（${MAX_QUEUE} 条），请稍后再发` })
        return
      }
      this.queue.push({ text, images: Array.isArray(images) ? images : [], reqId: clientReqId, client })
      this._send(client, { type: 'queued', position: this.queue.length, clientReqId })
      return
    }
    this._runInput(text, images, clientReqId, client, { isCommand })
  }

  async _runInput(text, images, reqId, origin = null, opts = {}) {
    try {
      // reqId 透传（审计 P1-5）：客户端自己的消息 ID 会一路带到 turn/start.reqId，
      // 否则客户端收到 queued / turn/start 时无法判断"这是不是我那条"，两条连续
      // 排队时只能靠时间猜哪段回答属于哪个气泡。
      await this.onSubmit(text, Array.isArray(images) ? images : [], reqId)
    } catch (e) {
      // 竞态：hub 判定空闲，但宿主（终端）刚好开了新回合。
      // 旧行为是 processInputLine 直接 return → 消息凭空消失，客户端零反馈。
      // 现在放回队首，等内核真正空闲再执行。
      //
      // 命令例外：命令从不排队（见 _handleInput），放回队列会让它排在一堆
      // 对话输入后面，"立即执行"的承诺又破了。命令失败就直接回错。
      if (e?.code === 'CC_NODE_BUSY' && !opts.isCommand) {
        this.queue.unshift({ text, images: Array.isArray(images) ? images : [], reqId, client: origin })
        this._scheduleRetry()
        return
      }
      // 执行失败是"这条请求的应答"，不是内核的全局事实：
      // 只回给发起它的那个视图。广播给所有人会让别的视图收到与自己无关的错误
      // （实测过：某个视图触发的命令在无 TTY 环境下报 readline closed，
      //   结果每个在线视图都收到一条莫名其妙的 error）。
      // origin 为空 = 队列里那条的发起者已断开，没人可回，只记日志。
      if (origin) this._send(origin, { type: 'error', text: `执行失败: ${e?.message || e}`, reqId })
      else this.log(`[attach] 排队输入执行失败（发起者已断开）: ${e?.message || e}`)
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
      this.bus.emit('session/loaded', { id: r.id, title: r.title, cwd: r.cwd || null, reason: 'load' })
      this.bus.emit('notice', { text: `会话已切换：${r.title || r.id}` })
    } catch (e) {
      this._send(client, { type: 'error', text: `切换会话失败: ${e?.message || e}` })
    }
  }

  /**
   * 新建会话（controller 专属）。
   *
   * 为什么要一条协议而不是让客户端发文本 `/clear`（审计 P0-4）：
   * 那等于强制所有接入方去记内核的内部命令语法，而"新建会话"是手机上三个
   * 必备按钮之一。协议化之后，App 不需要知道任何 `/命令`。
   */
  async _handleSessionNew(client, msg) {
    if (!this.onNewSession) {
      this._send(client, { type: 'error', text: '本内核不支持新建会话' })
      return
    }
    if (this._isBusy()) {
      this._send(client, { type: 'error', text: '当前有回合在跑，先 abort 再新建会话' })
      return
    }
    try {
      const r = await this.onNewSession(typeof msg.title === 'string' ? msg.title : '')
      if (!r || !r.ok) {
        this._send(client, { type: 'error', text: r?.error || '新建会话失败' })
        return
      }
      this.bus.emit('session/loaded', { id: r.id, title: r.title, cwd: r.cwd || null, reason: 'new' })
      this.bus.emit('notice', { text: `已新建会话：${r.title || r.id}` })
    } catch (e) {
      this._send(client, { type: 'error', text: `新建会话失败: ${e?.message || e}` })
    }
  }

  /**
   * 把一段文本回显给在线视图（`/命令` 的输出）。
   *
   * 为什么不走 EventBus：命令输出是"对某次请求的应答"，不是内核的全局事实。
   * 进 replay 的话，客户端重连会被一堆旧命令输出淹掉。
   *
   * @param {string} text
   * @param {object} [meta]
   * @param {string|null} [meta.reqId] 触发这条输出的命令对应的 clientReqId
   *   （接入反馈 P2-2）。一次命令的输出现在是一整段，但客户端仍需要知道
   *   "它属于哪条命令"——两条命令连着发、或输出与 AI 正文交错时会串台。
   * @param {boolean} [meta.done] 这条命令的输出到此结束。即便没有正文
   *   （命令无输出 / 只有副作用）也会发，客户端据此收尾气泡。
   */
  echo(text, meta = {}) {
    const body = String(text ?? '')
    const done = !!meta.done
    if (!body && !done) return
    for (const c of this.clients) {
      if (c.closed) continue
      if (c.legacy) {
        // legacy 只认 reply/error：命令输出降级成 reply，且不能因为 done 发空消息
        if (body) this._send(c, { type: 'reply', text: body })
      } else if (c.attached) {
        this._send(c, {
          type: 'command/output',
          text: body,
          reqId: meta.reqId ?? null,
          done,
        })
      }
    }
  }

  /**
   * 广播"某个定时任务被触发/执行完成"（审计 P2-7）。
   *
   * 走 EventBus 而不是直接写 socket：这样它也有 seq，断线重连能按序补齐，
   * 且和内核其他事实保持同一条时间线。
   */
  notifyScheduleEvent(kind, task, extra = {}) {
    if (this._disposed) return
    const t = task || {}
    this.bus.emit(kind, {
      taskId: t.id ?? null,
      taskKind: t.kind ?? null,
      status: extra.status ?? null,
      text: t.action?.text ?? null,
      cmd: t.action?.cmd ?? null,
      at: Date.now(),
    })
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
      // 注意：这里**不能** unref。
      // 确认超时是"必须触发"的语义（超时即拒绝），unref 的 timer 在没有其他
      // 事件源时不会把事件循环撑住 —— Node 20 上实测会直接挂住（测试里表现为
      // 整份用例被 cancelled）。dispose() 会清理它，不会拖住进程退出。
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

    // 回合结束 → 消化排队输入。
    //
    // ⚠️ 这里必须用**延迟调度**，绝不能在 turn/end 的同一个调用栈里直接 drain：
    // processMessage 是这么写的 ——
    //     bus.emit('turn/end', ...)     ← 此刻 state.isRunning 仍是 true
    //     return result
    //     finally { this.state.isRunning = false; bus.emit('status', {state:'idle'}) }
    // 所以同步 drain 必然命中 _isBusy() 早退，而之后又没有任何东西再触发它
    // → 排队的消息永久躺在队列里（这正是 v4.1.0 的排队死信 bug）。
    //
    // 真正的触发点是 status:idle（此时 isRunning 已为 false）；turn/end 留作
    // 兜底（宿主可能不发 status）。两者都走 setTimeout(0)，错开当前调用栈。
    if (ev.type === 'turn/end') this._scheduleDrain()
    else if (ev.type === 'status' && ev.state === 'idle') this._scheduleDrain()
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

  /** 延迟到当前调用栈之后再消化队列（幂等） */
  _scheduleDrain() {
    if (this._disposed || this._drainTimer) return
    if (!this.queue.length) return
    this._drainTimer = setTimeout(() => {
      this._drainTimer = null
      this._drainQueue()
    }, 0)
  }

  _scheduleRetry() {
    if (this._disposed || this._retryTimer) return
    if (++this._retryTries > RETRY_MAX_TRIES) {
      this._abandonQueue(`内核持续繁忙超过 ${Math.round(RETRY_MAX_TRIES * RETRY_MS / 60000)} 分钟`)
      return
    }
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      this._drainQueue()
    }, RETRY_MS)
  }

  /**
   * 放弃整条队列 —— 每条都回 error，绝不静默丢弃。
   *
   * 这不是"失败处理"的边角料：客户端已经把消息发出去了、界面在等结果，
   * 默默清空队列等于骗它。宁可报错让用户重发。
   */
  _abandonQueue(reason) {
    const dropped = this.queue.splice(0)
    this._retryTries = 0
    if (!dropped.length) return
    this.log(`[attach] 放弃 ${dropped.length} 条排队输入：${reason}`)
    for (const item of dropped) {
      if (item?.client && !item.client.closed) {
        this._send(item.client, {
          type: 'error',
          text: `排队消息未被执行（${reason}），请稍后重发`,
          reqId: item.reqId ?? null,
        })
      }
    }
  }

  _drainQueue() {
    if (this._disposed) return
    if (!this.queue.length) return
    if (this._isBusy()) {
      // 还在忙：等 status:idle（正常路径）。同时挂一个兜底重试，
      // 以防某个宿主既不 emit turn/end 也不 emit status（否则队列永久卡住）。
      this._scheduleRetry()
      return
    }
    const next = this.queue.shift()
    this._retryTries = 0   // 成功消化一条 → 重试计数归零（下一个回合重新算）
    // 让出事件循环：turn/end 的广播要先把"结束态"送到视图，再开下一回合
    Promise.resolve(this._runInput(next.text, next.images, next.reqId, next.client))
      .finally(() => {
        // 队里还有 → 接着消化。不能只依赖 status:idle：命令类输入
        // （/status 之类）根本不产生回合，也就不会有 idle 事件。
        if (this.queue.length) this._scheduleDrain()
      })
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

  /**
   * 读取某个会话的完整消息（审计 P1-6）。
   *
   * 为什么必须由内核提供而不是客户端自己读文件：桥可能跑在另一台机器上，
   * 客户端也可能刚重装、本地什么都没有。turn_history 只覆盖最近 20 个回合
   * （内存环形缓冲），更早的历史只有会话文件里有。
   */
  _sendSessionMessages(client, msg) {
    if (!this.onSessionMessages) {
      this._send(client, { type: 'error', text: '本内核不支持读取会话消息' })
      return
    }
    const q = {
      sessionId: msg.sessionId || this.sessionManager?.currentSession?.id || null,
      limit: Number.isFinite(msg.limit) ? msg.limit : 200,
      before: msg.before || null,
    }
    Promise.resolve()
      .then(() => this.onSessionMessages(q))
      .then((r) => {
        this._send(client, {
          type: 'session/messages',
          sessionId: r?.sessionId ?? q.sessionId,
          title: r?.title ?? null,
          messages: Array.isArray(r?.messages) ? r.messages : [],
          total: r?.total ?? 0,
          truncated: !!r?.truncated,
          nextBefore: r?.nextBefore ?? null,
          error: r?.error || null,
        })
      })
      .catch((e) => this._send(client, { type: 'error', text: `读取会话消息失败: ${e?.message || e}` }))
  }

  /**
   * 下发命令清单（接入反馈 P2-1）。
   *
   * 宿主没提供 getCommands 时回 supported:false —— 和 scheduler 一样，
   * 不能假装"支持但列表为空"，那会让客户端画出空面板。
   */
  _sendCommands(client) {
    if (!this.getCommands) {
      this._send(client, { type: 'commands', supported: false, list: [] })
      return
    }
    Promise.resolve()
      .then(() => this.getCommands())
      .then((list) => {
        this._send(client, {
          type: 'commands',
          supported: Array.isArray(list),
          list: Array.isArray(list) ? list : [],
        })
      })
      .catch((e) => this._send(client, { type: 'error', text: `读取命令清单失败: ${e?.message || e}` }))
  }

  /** 定时任务列表（审计 P2-7：文档承诺"客户端可见"，协议层必须有对应消息） */
  _sendSchedules(client, msg) {
    if (!this.getSchedules) {
      this._send(client, { type: 'scheduler/list', available: false, tasks: [] })
      return
    }
    Promise.resolve()
      .then(() => this.getSchedules())
      .then((tasks) => {
        // null = 宿主没有调度器（不能假装"有，只是空的"，那会让客户端以为任务被删光了）
        if (tasks == null) {
          this._send(client, { type: 'scheduler/list', available: false, tasks: [] })
          return
        }
        this._send(client, {
          type: 'scheduler/list',
          available: true,
          tasks: Array.isArray(tasks) ? tasks : [],
        })
      })
      .catch((e) => this._send(client, { type: 'error', text: `读取定时任务失败: ${e?.message || e}` }))
  }

  /**
   * 写一行 NDJSON。
   *
   * 背压处理（审计 P2-2）：socket.write() 返回 false 表示对端读得比我们写得慢。
   * 旧实现完全忽略返回值，长 tool/result 突发时会一路往内核内存里堆。
   * 现在的策略：
   *   · 背压期间把后续行放进 outBuf，等 'drain' 再冲刷；
   *   · 积压超过 MAX_OUTBUF 视为死视图，摘掉它（内核继续跑）。
   */
  _send(client, obj) {
    if (!client || client.closed) return
    let line
    try {
      line = JSON.stringify(obj) + '\n'
    } catch {
      return
    }

    if (client.backlogged) {
      client.outBuf.push(line)
      client.outBytes += line.length
      if (client.outBytes > MAX_OUTBUF) {
        this.log(`[attach] 视图输出积压超过 ${MAX_OUTBUF} 字节（对端不读），摘除该视图`)
        this.removeClient(client)
      }
      return
    }

    try {
      if (client.socket.write(line) === false) client.backlogged = true
    } catch {
      // 视图写失败 = 这个视图没了；摘掉它，内核继续跑
      this.removeClient(client)
    }
  }

  _onDrain(client) {
    if (!client || client.closed) return
    client.backlogged = false
    this._flushOut(client)
  }

  _flushOut(client) {
    if (client.flushing || client.closed) return
    client.flushing = true
    try {
      while (client.outBuf.length) {
        const line = client.outBuf.shift()
        client.outBytes -= line.length
        if (client.socket.write(line) === false) {
          client.backlogged = true
          return
        }
      }
      client.backlogged = false
    } catch {
      this.removeClient(client)
    } finally {
      client.flushing = false
    }
  }

  stats() {
    return {
      clients: this.clients.size,
      controllers: [...this.clients].filter(c => c.attached && c.role === 'controller').length,
      confirmable: [...this.clients].filter(c => c.attached && c.role === 'controller' && c.confirmable !== false).length,
      queued: this.queue.length,
      pendingConfirms: this._pendingConfirms.size,
    }
  }
}
