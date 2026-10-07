/**
 * 原子写文件 —— 先写同目录临时文件，再 `rename` 覆盖目标。
 *
 * 为什么需要：`fs.writeFile` 是**就地写**（`open('w')` 先把目标截断为 0，再分批 write）。
 * 进程若在写入中途被强杀 / 断电 / 崩溃，目标文件会**停留在"被截断"的中间状态**（内容丢失）。
 * 而 `rename` 在同一文件系统内是**原子**操作：读者要么看到完整旧内容、要么看到完整新内容，
 * 永远不会看到"写了一半"的文件；跨进程并发写也不会字节交错（最后一次 rename 胜出）。
 *
 * 语义保持（关键，别为了原子性破坏这些）：
 *   - **文件权限**：沿用目标文件已有的 mode（保住可执行位等）；目标不存在时用默认 0o666（受 umask 约束）
 *   - **软链接**：若目标路径是符号链接，写到它的**真实目标**，不破坏链接本身
 *
 * 失败清理：写临时文件 / rename 失败时，尽力删除临时文件后再抛错（不掩盖原错误）。
 *
 * @param {string} filePath 目标路径（可以是符号链接；父目录须已存在）
 * @param {string|Buffer} content 要写入的内容
 * @returns {Promise<void>}
 */
import { writeFile, rename, unlink, lstat, stat, realpath, readlink, chmod } from 'fs/promises'
import { dirname, basename, resolve, isAbsolute, join } from 'path'
import { randomBytes } from 'crypto'

/** 若目标是符号链接，解析出它真正指向的文件路径（不破坏链接） */
async function resolveWriteTarget(filePath) {
  try {
    const st = await lstat(filePath)
    if (st.isSymbolicLink()) {
      try {
        return await realpath(filePath)
      } catch {
        // 悬空链接（目标还不存在）：手动解析一级
        const link = await readlink(filePath)
        return isAbsolute(link) ? link : resolve(dirname(filePath), link)
      }
    }
  } catch { /* 目标不存在（新文件）→ 直接用原路径 */ }
  return filePath
}

export async function atomicWriteFile(filePath, content) {
  const target = await resolveWriteTarget(filePath)
  const dir = dirname(target)

  // 沿用已有权限（避免把 +x 等弄丢）；新文件交给 umask
  let mode = null
  try { mode = (await stat(target)).mode & 0o777 } catch { /* 新文件 */ }

  const tmp = join(dir, `.${basename(target)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    await writeFile(tmp, content, mode == null ? { encoding: 'utf-8' } : { encoding: 'utf-8', mode })
    // 某些 umask 会削减 mode，显式 chmod 保证与原文件一致（Windows 上为近似 no-op）
    if (mode != null) { try { await chmod(tmp, mode) } catch { /* 忽略 */ } }
    await rename(tmp, target)
  } catch (e) {
    try { await unlink(tmp) } catch { /* 清理失败不掩盖原错误 */ }
    throw e
  }
}
