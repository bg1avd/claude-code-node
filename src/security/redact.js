/**
 * 敏感数据自动脱敏
 *
 * 移植自 openclaw safe-jina-fetch 设计（DESIGN.md §4.4）。
 * 对响应内容扫描常见敏感模式，命中即替换为 [REDACTED:类型]，并在 warnings 中告警。
 * （原 Python 版只告警不脱敏，这里按 v2.0 设计升级为自动脱敏）
 */

/** 各类敏感模式的检测规则：{ 类型, 正则, 替换值 } */
const REDACT_RULES = [
  // API Key / Access Token / Auth Token（key= / token= 等 8 位以上值）
  {
    type: 'API-Key',
    regex: /(key|token|api[_-]?key|access[_-]?token|auth[_-]?token|secret)=(['"]?)[A-Za-z0-9_\-./+]{8,}\2/gi,
    value: '[REDACTED:API-Key]',
  },
  // Bearer Token（20 位以上）
  {
    type: 'Bearer',
    regex: /Bearer\s+[A-Za-z0-9_\-.]{20,}/gi,
    value: '[REDACTED:Bearer]',
  },
  // AWS Access Key（AKIA 开头 16 位）
  {
    type: 'AWS-Key',
    regex: /AKIA[0-9A-Z]{16}/g,
    value: '[REDACTED:AWS-Key]',
  },
  // AWS Secret Access Key
  {
    type: 'AWS-Secret',
    regex: /aws_secret_access_key\s*=\s*['"]?[A-Za-z0-9/+=]{20,}/gi,
    value: '[REDACTED:AWS-Secret]',
  },
  // 私钥
  {
    type: 'Private-Key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    value: '[REDACTED:Private-Key]',
  },
  // OpenAI 风格（sk- + 20 位以上字母数字）
  {
    type: 'OpenAI-Key',
    regex: /sk-[A-Za-z0-9]{20,}/g,
    value: '[REDACTED:OpenAI-Key]',
  },
  // Slack Token（xoxb / xoxa / xoxp / xoxr）
  {
    type: 'Slack-Token',
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    value: '[REDACTED:Slack-Token]',
  },
]

/**
 * 对文本执行敏感数据脱敏
 * @param {string} text
 * @returns {{text: string, redacted: string[]}} — 脱敏后的文本 + 命中的类型列表（去重）
 */
export function redactSensitiveData(text) {
  if (typeof text !== 'string' || !text) return { text: text || '', redacted: [] }

  let result = text
  const hitTypes = new Set()

  for (const rule of REDACT_RULES) {
    if (rule.regex.test(result)) {
      hitTypes.add(rule.type)
      // 重置 lastIndex（/g 正则 test 会改变 lastIndex）
      rule.regex.lastIndex = 0
      result = result.replace(rule.regex, rule.value)
    }
  }

  return { text: result, redacted: [...hitTypes] }
}
