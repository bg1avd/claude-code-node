/**
 * 零依赖 SOCKS5 代理连接器
 *
 * 用于 Telegram Bot API 通过 SOCKS5 代理访问（突破网络限制）
 *
 * 用法:
 *   const tunnel = socks5Connect('127.0.0.1:1080', 'api.telegram.org', 443)
 *   const tlsSocket = tls.connect({ socket: tunnel, host: 'api.telegram.org', servername: 'api.telegram.org' })
 *
 * SOCKS5 协议参考: RFC 1928
 */

import { connect as tcpConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/**
 * 建立 SOCKS5 隧道连接
 *
 * @param {string} proxyHost - 代理主机
 * @param {number} proxyPort - 代理端口
 * @param {string} targetHost - 目标主机
 * @param {number} targetPort - 目标端口
 * @param {object} [opts]
 * @param {string} [opts.username] - SOCKS5 用户名（可选）
 * @param {string} [opts.password] - SOCKS5 密码（可选）
 * @returns {Promise<import('node:net').Socket>}
 */
export function socks5Connect(proxyHost, proxyPort, targetHost, targetPort, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: proxyHost, port: proxyPort })
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('SOCKS5 proxy timeout'))
    }, 10000)

    socket.once('connect', async () => {
      try {
        // 创建持久的字节缓冲读取器，避免多次 readBytes 丢失多余字节
        const reader = createByteReader(socket)

        // Step 1: 握手 — 协商认证方式
        const authMethods = opts.username ? [0x00, 0x02] : [0x00]  // 无认证 + 用户名密码
        socket.write(Buffer.from([0x05, authMethods.length, ...authMethods]))

        const handshake = await reader.read(2)
        if (handshake[0] !== 0x05) {
          throw new Error('SOCKS5: 版本不匹配')
        }

        // Step 2: 认证（如果需要）
        if (handshake[1] === 0x02) {
          if (!opts.username) throw new Error('SOCKS5: 代理需要用户名密码')
          const u = Buffer.from(opts.username, 'utf8')
          const p = Buffer.from(opts.password, 'utf8')
          const authReq = Buffer.from([0x01, u.length, ...u, p.length, ...p])
          socket.write(authReq)
          const authResp = await reader.read(2)
          if (authResp[1] !== 0x00) throw new Error('SOCKS5: 认证失败')
        } else if (handshake[1] !== 0x00) {
          throw new Error('SOCKS5: 代理不支持不需要的认证方式')
        }

        // Step 3: 发送连接请求
        const hostType = /^\d+\.\d+\.\d+\.\d+$/.test(targetHost) ? 0x01 : 0x03
        let addr
        if (hostType === 0x01) {
          addr = Buffer.from(targetHost.split('.').map(Number))
        } else {
          const hostBuf = Buffer.from(targetHost, 'utf8')
          addr = Buffer.from([hostBuf.length, ...hostBuf])
        }

        const portBuf = Buffer.alloc(2)
        portBuf.writeUInt16BE(targetPort)
        const connectReq = Buffer.from([0x05, 0x01, 0x00, hostType, ...addr, ...portBuf])
        socket.write(connectReq)

        const connectResp = await reader.read(4)
        if (connectResp[0] !== 0x05 || connectResp[1] !== 0x00) {
          const errors = { 0x01: '通用错误', 0x02: '不允许', 0x03: '网络不可达', 0x04: '主机不可达', 0x05: '连接被拒', 0x06: 'TTL超时', 0x07: '命令不支持', 0x08: '地址类型不支持' }
          throw new Error(`SOCKS5: 连接失败 — ${errors[connectResp[1]] || `错误码 ${connectResp[1]}`}`)
        }

        // 读取剩余响应包头（根据地址类型）
        const addrType = connectResp[3]
        if (addrType === 0x01) await reader.read(6)  // IPv4 + port
        else if (addrType === 0x03) {
          const len = (await reader.read(1))[0]
          await reader.read(len + 2)  // hostname + port
        } else if (addrType === 0x04) await reader.read(18)  // IPv6 + port

        // 清理 reader 的监听器，确保隧道建立后数据完整交给调用方
        reader.detach()

        clearTimeout(timeout)
        resolve(socket)
      } catch (e) {
        socket.destroy()
        clearTimeout(timeout)
        reject(e)
      }
    })

    socket.once('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

/**
 * 创建持久的字节缓冲读取器。
 *
 * 原实现每次 readBytes 都重新注册 'data' 监听器，当 SOCKS5 代理
 * 一次性返回多段响应时，首个 readBytes 会消费掉多余字节并丢弃，
 * 导致后续 readBytes 永远等待，最终触发超时。此读取器用统一的
 * 内部缓冲队列累积所有到达的字节，保证多次读取之间字节不丢失。
 *
 * @param {import('node:net').Socket} socket
 */
function createByteReader(socket) {
  let buffer = Buffer.alloc(0)
  let closed = false
  const waiters = []

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    flush()
  }

  const onError = () => {
    closed = true
    flush()
  }

  const onEnd = () => {
    closed = true
    flush()
  }

  socket.on('data', onData)
  socket.once('error', onError)
  socket.once('end', onEnd)

  function flush() {
    while (waiters.length > 0) {
      const waiter = waiters[0]
      if (buffer.length >= waiter.n) {
        waiters.shift()
        const out = buffer.slice(0, waiter.n)
        buffer = buffer.slice(waiter.n)
        waiter.resolve(out)
      } else {
        break
      }
    }
    // 所有等待者都已满足，但连接已关闭且字节不足 -> 报错
    if (closed && waiters.length > 0 && buffer.length === 0) {
      const waiter = waiters.shift()
      waiter.reject(new Error('SOCKS5: 连接意外关闭'))
    }
  }

  return {
    read(n) {
      return new Promise((resolve, reject) => {
        if (n === 0) return resolve(Buffer.alloc(0))
        // 先检查已有缓冲
        if (buffer.length >= n) {
          const out = buffer.slice(0, n)
          buffer = buffer.slice(n)
          return resolve(out)
        }
        // 连接已关闭且缓冲不足
        if (closed) {
          return reject(new Error('SOCKS5: 连接意外关闭'))
        }
        waiters.push({ n, resolve, reject })
        flush()
      })
    },
    detach() {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('end', onEnd)
    },
  }
}

/**
 * 创建通过 SOCKS5 代理的 TLS 连接
 *
 * @param {string} proxyAddr - 代理地址, 如 "127.0.0.1:1080" 或 "socks5://user:pass@host:port"
 * @param {string} targetHost - 目标主机名 (如 "api.telegram.org")
 * @param {number} targetPort - 目标端口 (如 443)
 * @returns {Promise<import('node:tls').TLSSocket>}
 */
export async function createTlsTunnel(proxyAddr, targetHost, targetPort = 443) {
  // 解析代理地址格式
  let p = proxyAddr
  let username, password

  if (p.startsWith('socks5://')) {
    p = p.slice(9)
    const atIdx = p.lastIndexOf('@')
    if (atIdx >= 0) {
      const auth = p.slice(0, atIdx)
      const colon = auth.indexOf(':')
      username = colon >= 0 ? decodeURIComponent(auth.slice(0, colon)) : decodeURIComponent(auth)
      password = colon >= 0 ? decodeURIComponent(auth.slice(colon + 1)) : ''
      p = p.slice(atIdx + 1)
    }
  }

  const colon = p.lastIndexOf(':')
  if (colon < 0) throw new Error(`SOCKS5: 无效代理地址 "${proxyAddr}"`)
  const proxyHost = p.slice(0, colon)
  const proxyPort = parseInt(p.slice(colon + 1), 10)

  const socket = await socks5Connect(proxyHost, proxyPort, targetHost, targetPort, { username, password })
  const tlsSocket = tlsConnect({
    socket,
    host: targetHost,
    servername: targetHost,
  })

  return new Promise((resolve, reject) => {
    tlsSocket.once('secureConnect', () => resolve(tlsSocket))
    tlsSocket.once('error', reject)
    setTimeout(() => reject(new Error('TLS handshake timeout')), 15000)
  })
}

/**
 * 发起 HTTPS 请求通过 SOCKS5 代理
 *
 * @param {string} url - 请求 URL
 * @param {object} options - fetch 选项
 * @param {string} proxyAddr - SOCKS5 代理地址
 * @returns {Promise<Response>}
 */
export async function fetchViaSocks5(url, options = {}, proxyAddr) {
  const parsedUrl = new URL(url)
  const isHttps = parsedUrl.protocol === 'https:'
  const port = parseInt(parsedUrl.port, 10) || (isHttps ? 443 : 80)
  const host = parsedUrl.hostname

  let socket
  if (isHttps) {
    socket = await createTlsTunnel(proxyAddr, host, port)
  } else {
    const [proxyHost, proxyPort] = proxyAddr.replace(/^socks5:\/\//, '').split(':')
    socket = await socks5Connect(proxyHost, parseInt(proxyPort, 10), host, port)
  }

  // 构建 HTTP 请求
  const path = parsedUrl.pathname + parsedUrl.search
  const headers = Object.entries(options.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\r\n')
  // body 必须是字符串/Buffer；FormData/Blob 等 multipart 正文当前不支持
  // （仅用于 Telegram Bot API 的 JSON 请求），遇到非字符串 body 给出清晰错误而非崩溃。
  const body = options.body || ''
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
    socket.destroy()
    return Promise.reject(new Error('fetchViaSocks5: 仅支持 string/Buffer 请求体（不支持 FormData 等 multipart）'))
  }
  // 注意：Content-Length 必须用 UTF-8 字节数，不能用字符串字符数，
  // 否则包含中文/emoji 时会导致服务器读不完整请求体。
  const bodyLen = Buffer.byteLength(body, 'utf8')
  const head = `${options.method || 'GET'} ${path} HTTP/1.1\r\nHost: ${host}\r\n${headers ? headers + '\r\n' : ''}Content-Length: ${bodyLen}\r\nConnection: close\r\n\r\n`
  const reqBuf = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')])

  return new Promise((resolve, reject) => {
    // 用 Buffer 数组收集响应，避免二进制数据（图片/文件）被 UTF-8 字符串解码损坏
    const chunks = []
    // 超时可配置（options.timeout，毫秒），默认 30s。
    // Telegram getUpdates 是长轮询（最多等 30s），必须传更大的超时避免误判超时。
    const timeoutMs = options.timeout || 30000
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('HTTP request timeout'))
    }, timeoutMs)

    // 支持 AbortController 取消（如 flushOffset 想中断挂起的长轮询以独占 bot 连接）。
    // 触发 abort 时销毁 socket，使挂起的请求立即以 AbortError 结束，而不是等 HTTP 超时。
    const signal = options.signal
    const onAbort = () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      clearTimeout(timeout)
      socket.destroy()
      reject(err)
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }

    socket.write(reqBuf)
    socket.on('data', (chunk) => {
      chunks.push(chunk)
    })
    socket.on('end', () => {
      clearTimeout(timeout)
      if (signal) signal.removeEventListener('abort', onAbort)
      // 解析 HTTP 响应
      const rawBuf = Buffer.concat(chunks)
      const headerEnd = rawBuf.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        reject(new Error('Invalid HTTP response'))
        return
      }
      const headerStr = rawBuf.slice(0, headerEnd).toString('utf8')
      const statusLine = headerStr.split('\r\n')[0]
      const statusCode = parseInt(statusLine.split(' ')[1], 10)
      const bodyBuf = rawBuf.slice(headerEnd + 4)

      resolve({
        ok: statusCode >= 200 && statusCode < 300,
        status: statusCode,
        statusText: statusLine,
        headers: {},
        arrayBuffer: async () => bodyBuf.buffer.slice(bodyBuf.byteOffset, bodyBuf.byteOffset + bodyBuf.byteLength),
        text: async () => bodyBuf.toString('utf8'),
        json: async () => JSON.parse(bodyBuf.toString('utf8')),
      })
    })
    socket.on('error', (err) => {
      clearTimeout(timeout)
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(err)
    })
  })
}