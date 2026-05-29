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
        // Step 1: 握手 — 协商认证方式
        const authMethods = opts.username ? [0x00, 0x02] : [0x00]  // 无认证 + 用户名密码
        socket.write(Buffer.from([0x05, authMethods.length, ...authMethods]))

        const handshake = await readBytes(socket, 2)
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
          const authResp = await readBytes(socket, 2)
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

        const connectResp = await readBytes(socket, 4)
        if (connectResp[0] !== 0x05 || connectResp[1] !== 0x00) {
          const errors = { 0x01: '通用错误', 0x02: '不允许', 0x03: '网络不可达', 0x04: '主机不可达', 0x05: '连接被拒', 0x06: 'TTL超时', 0x07: '命令不支持', 0x08: '地址类型不支持' }
          throw new Error(`SOCKS5: 连接失败 — ${errors[connectResp[1]] || `错误码 ${connectResp[1]}`}`)
        }

        // 读取剩余响应包头（根据地址类型）
        const addrType = connectResp[3]
        if (addrType === 0x01) await readBytes(socket, 6)  // IPv4 + port
        else if (addrType === 0x03) {
          const len = (await readBytes(socket, 1))[0]
          await readBytes(socket, len + 2)  // hostname + port
        } else if (addrType === 0x04) await readBytes(socket, 18)  // IPv6 + port

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
  const body = options.body || ''
  const req = `${options.method || 'GET'} ${path} HTTP/1.1\r\nHost: ${host}\r\n${headers ? headers + '\r\n' : ''}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`

  return new Promise((resolve, reject) => {
    let responseData = ''
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('HTTP request timeout'))
    }, 30000)

    socket.write(req)
    socket.on('data', (chunk) => {
      responseData += chunk.toString()
    })
    socket.on('end', () => {
      clearTimeout(timeout)
      // 解析 HTTP 响应
      const headerEnd = responseData.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        reject(new Error('Invalid HTTP response'))
        return
      }
      const statusLine = responseData.split('\r\n')[0]
      const statusCode = parseInt(statusLine.split(' ')[1], 10)
      const bodyData = responseData.slice(headerEnd + 4)

      resolve({
        ok: statusCode >= 200 && statusCode < 300,
        status: statusCode,
        statusText: statusLine,
        headers: {},
        text: async () => bodyData,
        json: async () => JSON.parse(bodyData),
      })
    })
    socket.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

/** 从 socket 读取指定字节数 */
function readBytes(socket, n) {
  return new Promise((resolve, reject) => {
    if (n === 0) return resolve(Buffer.alloc(0))
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length >= n) {
        socket.removeListener('data', onData)
        resolve(buf.slice(0, n))
      }
    }
    socket.on('data', onData)
    socket.once('error', reject)
    // 处理已经缓冲的数据
    if (buf.length >= n) {
      socket.removeListener('data', onData)
      resolve(buf.slice(0, n))
    }
  })
}
