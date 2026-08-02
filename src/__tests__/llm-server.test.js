/**
 * llm-server 单元测试
 *
 * 覆盖 isLocalLlmServer / isLocalHostname / buildAuthHeaders
 * 用于验证自建本地 LLM 服务（Ollama / llama.cpp / vLLM）识别逻辑
 */

import { test, describe } from 'node:test'
import assert from 'node:assert'

import { isLocalLlmServer, isLocalHostname, buildAuthHeaders } from '../utils/llm-server.js'

describe('isLocalHostname', () => {
  const localCases = ['localhost', '127.0.0.1', '192.168.1.50', '10.0.0.5', '172.20.1.1',
    '172.16.1.1', '172.31.255.255', '169.254.1.1', 'myhost.local', 'server.lan', '::1', 'fc00::1']
  localCases.forEach(h => {
    test(`应识别为本地: ${h}`, () => assert.strictEqual(isLocalHostname(h), true))
  })

  // 172.5 不在私有段（172.16-31）
  const nonLocalCases = ['172.5.1.1', '8.8.8.8', '114.114.114.114', 'api.deepseek.com', 'example.com']
  nonLocalCases.forEach(h => {
    test(`不应识别为本地: ${h}`, () => assert.strictEqual(isLocalHostname(h), false))
  })
})

describe('isLocalLlmServer', () => {
  test('Ollama 本机', () => assert.strictEqual(isLocalLlmServer('http://localhost:11434/v1'), true))
  test('Ollama 回环', () => assert.strictEqual(isLocalLlmServer('http://127.0.0.1:11434/v1'), true))
  test('Ollama 内网', () => assert.strictEqual(isLocalLlmServer('http://192.168.1.50:11434/v1'), true))
  test('vLLM 内网 10.x', () => assert.strictEqual(isLocalLlmServer('http://10.0.0.5:8000/v1'), true))
  test('llama.cpp 内网 172.x', () => assert.strictEqual(isLocalLlmServer('http://172.20.1.1:8000/v1'), true))
  test('无端口内网', () => assert.strictEqual(isLocalLlmServer('http://192.168.1.50/v1'), true))
  test('.local 域名', () => assert.strictEqual(isLocalLlmServer('http://myhost.local:11434/v1'), true))
  test('无 /v1 前缀也可', () => assert.strictEqual(isLocalLlmServer('http://192.168.1.50:11434'), true))

  test('DeepSeek 云端', () => assert.strictEqual(isLocalLlmServer('https://api.deepseek.com/v1'), false))
  test('OpenAI 云端', () => assert.strictEqual(isLocalLlmServer('https://api.openai.com/v1'), false))
  test('通义云端', () => assert.strictEqual(isLocalLlmServer('https://dashscope.aliyuncs.com/v1'), false))
  test('公网 IP', () => assert.strictEqual(isLocalLlmServer('http://114.114.114.114:11434/v1'), false))
  test('空值', () => assert.strictEqual(isLocalLlmServer(''), false))
})

describe('buildAuthHeaders', () => {
  test('本地服务 + 有 key → 带 Bearer', () => {
    assert.deepStrictEqual(buildAuthHeaders('http://192.168.1.50:11434/v1', 'secret'),
      { 'Authorization': 'Bearer secret' })
  })
  test('本地服务 + 无 key → 空对象(不带Authorization)', () => {
    assert.deepStrictEqual(buildAuthHeaders('http://192.168.1.50:11434/v1', ''), {})
  })
  test('云端 + 有 key → 带 Bearer', () => {
    assert.deepStrictEqual(buildAuthHeaders('https://api.deepseek.com/v1', 'sk-x'),
      { 'Authorization': 'Bearer sk-x' })
  })
  test('云端 + 无 key → undefined', () => {
    assert.strictEqual(buildAuthHeaders('https://api.deepseek.com/v1', ''), undefined)
  })
  test('空 apiBase + 无 key → undefined', () => {
    assert.strictEqual(buildAuthHeaders('', ''), undefined)
  })
})
