/**
 * dsh-agent-browser 的**纯逻辑层**（无 IO、时间注入、可离线单测）。
 *
 * 为什么单独成文件（2026-09-12）：本插件原先三处决策埋在模块级 `state` 与 apply 闭包里——
 * ① 客户端状态文件的解析与校验、② 心跳页面的归一化、③ 日志环形缓冲的截断与上限。
 * 浏览器心跳是**存活链的一环**，这些判定此前**零自动化证据**（package.json 的 `test` 还指向
 * 不存在的 `test/` 目录）。按 `dsh-plugin-testability` 抽出纯函数后用 `lib/logic.js` 直测。
 *
 * 纪律：本文件**不做 IO、不读时钟**（now 由调用方注入）、不 import 宿主包（避免跨包类型漂移，
 * 见 AGENTS.md §5.15 §4）。类型一律本地结构化定义。
 */

/** 客户端状态文件的内容（与 $DSH_HOME/.browser-client-state.json 对应）。 */
export interface ClientState {
  lastSeenAt: number
  page: string
}

/** 日志条目（宿主缓冲用；保持与 index.ts 的 BrowserLog 结构兼容——含同样的索引签名）。 */
export interface LogItem {
  t: number
  level: string
  text: string
  page: string
  [k: string]: unknown
}

/** 上报进原始条目（client 可能送出不完整字段）。 */
export interface RawLogItem {
  t?: unknown
  level?: unknown
  text?: unknown
}

/** 已有缓冲条目（`page` 可选，与 index.ts 的 `BrowserLog` 兼容）。 */
export interface ExistingLogItem {
  t: number
  level: string
  text: string
  page?: string
}

/** 页面标识截断上限（防 client 送出超长 URL 撑爆状态文件）。 */
export const PAGE_MAX = 300

/** 心跳页面归一化：非字符串或空 → 保持原值语义（返回 ''），超长截断。 */
export function normalizePage(page: unknown): string {
  if (typeof page !== 'string') return ''
  return page.slice(0, PAGE_MAX)
}

/**
 * 解析客户端状态文件内容。
 * 返回 `null` 表示「不可用」（文件损坏 / 形状不符）——**调用方应保持内存态不动**，
 * 而不是用半截数据覆盖（半截数据比没有数据更危险：会把「上次在场时间」污染成错误值）。
 */
export function parseClientState(raw: string): ClientState | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (typeof o.lastSeenAt !== 'number' || !Number.isFinite(o.lastSeenAt)) return null
  if (typeof o.page !== 'string') return null
  return { lastSeenAt: o.lastSeenAt, page: o.page }
}

/**
 * 单条上报 → 日志条目（或 `null` 表示丢弃）。
 * 丢弃条件：文本为**空串**（行为与原实现一致：纯空白如 `' '` 仍保留）。level/t 缺失走默认值，不丢条目。
 * 注：`t` 若为 `NaN`/`Infinity` 会回落到 `nowMs`（比原实现更严——原实现只判 `typeof number`）。
 */
export function toLogItem(raw: RawLogItem, opts: { maxText: number; page: string; nowMs: number }): LogItem | null {
  const rawText = raw?.text
  const text = typeof rawText === 'string' ? rawText.slice(0, opts.maxText) : String(rawText ?? '')
  if (!text) return null
  const level = typeof raw?.level === 'string' ? raw.level : 'info'
  const t = typeof raw?.t === 'number' && Number.isFinite(raw.t) ? raw.t : opts.nowMs
  return { t, level, text, page: opts.page }
}

/**
 * 追加一批上报到缓冲区并施加环形上限（**保留最新的 maxLogs 条**）。
 * 纯函数：不修改入参，返回新数组。
 * 入参放宽为「已有条目」（`page` 可选，兼容既有 `BrowserLog`），返回严格 `LogItem[]`。
 */
export function appendLogs(
  existing: readonly ExistingLogItem[],
  incoming: readonly RawLogItem[],
  opts: { maxLogs: number; maxText: number; page: string; nowMs: number },
): LogItem[] {
  const added: LogItem[] = []
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const item = toLogItem(raw, opts)
    if (item !== null) added.push(item)
  }
  const merged: LogItem[] = existing.map((e) => ({
    t: e.t, level: e.level, text: e.text, page: e.page ?? opts.page,
  }))
  merged.push(...added)
  const max = opts.maxLogs > 0 ? opts.maxLogs : 0
  return merged.length > max ? merged.slice(merged.length - max) : merged
}

/**
 * 心跳新鲜度判定（**新增的显式判据**，供存活观测使用）。
 * 与 SOUL 主题一致：判在场要用可验证的时间证据，不用代理量（§5.17 §2）。
 */
export function isClientFresh(lastSeenAt: number, nowMs: number, ttlMs: number): boolean {
  if (!Number.isFinite(lastSeenAt) || !Number.isFinite(nowMs) || !Number.isFinite(ttlMs)) return false
  if (lastSeenAt <= 0) return false
  const age = nowMs - lastSeenAt
  if (age < 0) return false   // 未来时间戳：时钟偏移，不可信 → 判不在场（fail-closed）
  return age <= ttlMs
}
