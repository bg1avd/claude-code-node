/**
 * 自定义工具加载器 —— 机器级 / 项目级（目录式）
 *
 * 背景（用户诉求）：每台机器只装一个 cc-node；工具是"这台机器级"的资产。
 * 写一次（例如一个"生成图表"的工具），无论从哪个子目录启动 cc-node 都应能直接调用，
 * 不需要每个角色/子目录再去指定路径。
 *
 * 目录约定（**目录名 = 工具名**）：
 *   ~/.cc-node/tools/<tool-name>/index.js          ← 机器级：所有子目录共享
 *   <项目>/.claude-code/tools/<tool-name>/index.js  ← 项目级：该角色专属（覆盖机器级同名）
 *   config.tools.customDirs 里列出的目录            ← 额外目录（最高优先级）
 *   每个工具目录可附 README.md 说明（不参与加载，仅供人读/供 AI 参考）。
 *
 * index.js 导出契约（任一即可，加载器统一归一化为 ToolDef）：
 *   export default { name, description, parameters, permissionLevel, handler }
 *   export const tool  = { ... }
 *   export const tools = [ { ... }, ... ]
 *   export default async function handler(input, ctx) { return '文本结果' }
 *   module.exports = { ... } / module.exports = fn        // CJS 兼容（建议用 .cjs）
 *
 * 设计原则（对齐 MCP 装载 best-effort 风格）：
 *   - 单个文件 import 失败只告警跳过，**绝不阻塞/崩溃启动**
 *   - 同名去重：项目级 > 机器级（高优先级覆盖低优先级）
 *   - 与"内置工具/MCP 工具"的同名冲突由调用方处理（内置/MCP 优先）
 */
import { readdir, stat, writeFile } from 'fs/promises'
import { join, extname } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'
import { ToolDef } from '../types/index.js'
import { sanitizeToolName } from '../mcp/loadTools.js'

/** 机器级工具目录：~/.cc-node/tools（所有子目录的 cc-node 共享） */
export function machineToolsDir() {
  return join(homedir(), '.cc-node', 'tools')
}

/** 项目级工具目录：<cwd>/.claude-code/tools（该角色/项目专属） */
export function projectToolsDir(cwd = process.cwd()) {
  return join(cwd, '.claude-code', 'tools')
}

/** 展开开头的 ~ 为 home 目录 */
export function expandHome(p) {
  if (typeof p !== 'string' || !p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

async function isDir(p) {
  try { return (await stat(p)).isDirectory() } catch { return false }
}
async function isFile(p) {
  try { return (await stat(p)).isFile() } catch { return false }
}

/** 工具文件扩展名（.js 走 ESM，.mjs 强制 ESM，.cjs 强制 CJS） */
const TOOL_EXTS = ['.js', '.mjs', '.cjs']

/**
 * 在工具根目录补一个 `package.json {"type":"module"}`（若缺失）。
 *
 * 必要性：`~/.cc-node/tools/` 下没有 package.json 时，Node 会把 `index.js` 当 CJS 解析，
 * 于是我们约定的 ESM 写法（`export default {...}`）会直接 SyntaxError。
 * 补上这个标记后，工具目录里的 `.js` 一律按 ESM 解析（CJS 工具请用 `.cjs` 后缀）。
 */
async function ensureEsmRoot(dir) {
  const pkg = join(dir, 'package.json')
  if (await isFile(pkg)) return
  try {
    await writeFile(pkg, '{\n  "type": "module"\n}\n', { flag: 'wx' })
  } catch { /* 已存在 / 无权限 → 忽略，交给 import 报明确错误 */ }
}

/**
 * 把 index.js 的一个导出值归一化为 ToolDef。
 * 支持：ToolDef 实例 / 纯对象（含 handler|execute|run）/ 函数（当 handler）。
 * @param {*} raw
 * @param {string} fallbackName 目录名（缺省工具名）
 * @returns {ToolDef|null}
 */
export function normalizeTool(raw, fallbackName) {
  if (raw == null) return null

  // 已是 ToolDef 实例
  if (raw instanceof ToolDef) {
    if (!raw.name) raw.name = sanitizeToolName(fallbackName)
    return raw
  }

  // 纯对象
  if (typeof raw === 'object') {
    const handler = raw.handler || raw.execute || raw.run || raw.default
    if (typeof handler !== 'function') return null
    const name = sanitizeToolName(raw.name || fallbackName)
    return new ToolDef(
      name,
      raw.description || `自定义工具 ${name}`,
      raw.parameters || { type: 'object', properties: {} },
      (input, ctx) => handler(input || {}, ctx),
      raw.permissionLevel || 'ask',
    )
  }

  // 函数 → 当 handler，名字取目录名
  if (typeof raw === 'function') {
    const name = sanitizeToolName(fallbackName)
    return new ToolDef(
      name,
      raw.description || `自定义工具 ${name}`,
      { type: 'object', properties: {} },
      (input, ctx) => raw(input || {}, ctx),
      'ask',
    )
  }

  return null
}

/** 从模块导出里收集所有候选原始工具定义 */
function collectExports(mod) {
  const out = []
  if (mod == null) return out
  if (mod.tools !== undefined) {
    if (Array.isArray(mod.tools)) out.push(...mod.tools)
    else out.push(mod.tools)
  }
  if (mod.tool !== undefined) out.push(mod.tool)
  if (mod.default !== undefined) out.push(mod.default)
  return out.filter((x) => x != null)
}

/** 加载单个 index.js 文件，返回 ToolDef[] */
async function loadToolFile(filePath, fallbackName, log) {
  const mod = await import(pathToFileURL(filePath).href)
  const raws = collectExports(mod)
  const defs = []
  for (const raw of raws) {
    const def = normalizeTool(raw, fallbackName)
    if (def) defs.push(def)
    else log && log(`[custom-tools] 跳过无法识别的导出: ${filePath}`)
  }
  return defs
}

/**
 * 扫描一个目录，返回 { tools, errors }。
 * 支持两种布局：<dir>/<name>/index.{js,mjs,cjs}（推荐）与 <dir>/<name>.{js,mjs,cjs}。
 * @param {string} dir
 * @param {{source?:string, log?:(m:string)=>void, ensureModule?:boolean}} opts
 */
export async function loadToolsFromDir(dir, { source = 'custom', log, ensureModule = true } = {}) {
  const tools = []
  const errors = []
  if (!(await isDir(dir))) return { tools, errors }
  // 让目录里的 .js 按 ESM 解析（否则 export default 会 SyntaxError）
  if (ensureModule) await ensureEsmRoot(dir)

  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch (e) {
    return { tools, errors: [{ dir, error: e }] }
  }

  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'package.json') continue

    let filePath = null
    let fallbackName = ent.name

    if (ent.isDirectory()) {
      const job = join(dir, ent.name)
      for (const ext of TOOL_EXTS) {
        const cand = join(job, `index${ext}`)
        if (await isFile(cand)) { filePath = cand; break }
      }
    } else if (ent.isFile() && TOOL_EXTS.includes(extname(ent.name))) {
      filePath = join(dir, ent.name)
      fallbackName = ent.name.replace(/\.(mjs|cjs|js)$/i, '')
    }
    if (!filePath) continue

    try {
      const defs = await loadToolFile(filePath, fallbackName, log)
      for (const d of defs) {
        d._source = source
        d._customDir = dir
        tools.push(d)
      }
      if (defs.length === 0) log && log(`[custom-tools] ${filePath} 未导出可用工具，跳过`)
    } catch (e) {
      errors.push({ file: filePath, error: e })
      log && log(`[custom-tools] 加载失败 ${filePath}: ${e.message}`)
    }
  }
  return { tools, errors }
}

/**
 * 按优先级加载全部自定义工具。
 * 优先级（低 → 高）：机器级 < 项目级 < config.tools.customDirs（后者覆盖前者同名）。
 *
 * @param {{cwd?:string, extraDirs?:string[], log?:(m:string)=>void}} opts
 * @returns {Promise<{tools:ToolDef[], errors:Array}>}
 */
export async function loadCustomTools({ cwd = process.cwd(), extraDirs = [], log } = {}) {
  const layers = [
    { dir: machineToolsDir(), source: 'machine' },
    { dir: projectToolsDir(cwd), source: 'project' },
    ...(Array.isArray(extraDirs) ? extraDirs : []).map((d) => ({ dir: expandHome(d), source: 'config' })),
  ]

  const byName = new Map() // name -> ToolDef（后写覆盖）
  const order = []         // 首次出现顺序
  const errors = []

  for (const layer of layers) {
    if (!layer.dir) continue
    const { tools, errors: errs } = await loadToolsFromDir(layer.dir, { source: layer.source, log })
    errors.push(...errs)
    for (const t of tools) {
      if (!byName.has(t.name)) order.push(t.name)
      byName.set(t.name, t) // 高优先级覆盖低优先级
    }
  }

  const tools = order.map((n) => byName.get(n)).filter(Boolean)
  return { tools, errors }
}
