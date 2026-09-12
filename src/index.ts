/**
 * dsh-agent-browser：浏览器工具插件。
 *
 * client 面（浏览器内）：hook console.error/warn/info + window error/unhandledrejection，
 * 批量上报宿主——agent 从此可以「自己看 F12 Console」。
 * host 面：日志环形缓冲 + browser_console 工具（读取）+ browser_page（页面信息）。
 * @module dsh-agent-browser
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { appendLogs, normalizePage, parseClientState } from './logic.ts'

export const name = 'agent-browser'
export const inject = ['tools', 'webServer'] as const

export interface Config {
  /** 日志缓冲上限（条）。 */
  maxLogs: number
  /** 单条文本截断长度。 */
  maxText: number
}
export const Config = z.object({
  maxLogs: z.number().default(500),
  maxText: z.number().default(800),
})

export interface BrowserLog {
  t: number
  level: string
  text: string
  page?: string
  [k: string]: unknown
}

/** 浏览器 client 心跳状态（持久化到 $DSH_HOME/.browser-client-state.json，重启不丢）。 */
export interface BrowserClientState {
  lastSeenAt: number
  page: string
}

/**
 * 模块级共享状态：remote 服务 / 工具 / webServer 路由共用（不依赖实例获取）。
 * 心跳持久化到 $DSH_HOME/.browser-client-state.json，web 重启不丢。
 */
const state = {
  logs: [] as BrowserLog[],
  page: '',
  phase: '' as string,
  lastSeenAt: 0,
  stateFile: '',
  maxLogs: 500,
  maxText: 800,
}
export function loadClientState(dshHome: string): void {
  state.stateFile = dshHome ? join(dshHome, '.browser-client-state.json') : ''
  if (!state.stateFile) return
  let raw: string
  try {
    raw = readFileSync(state.stateFile, 'utf8')
  } catch { return /* 首次运行/文件缺失：从零开始 */ }
  const saved = parseClientState(raw)
  // 损坏 / 形状不符 → **保持内存态不动**：半截数据比没有数据更危险（会污染「上次在场时间」）
  if (saved === null) return
  state.lastSeenAt = saved.lastSeenAt
  state.page = saved.page
}
function persistState(): void {
  if (!state.stateFile) return
  try { writeFileSync(state.stateFile, JSON.stringify({ lastSeenAt: state.lastSeenAt, page: state.page }), 'utf8') } catch { /* 持久化失败不影响服务 */ }
}
/** 裸心跳入口（webServer 路由调用）：client 只要执行了 apply 就会周期上报。 */
export function heartbeat(page: string, phase = ''): void {
  const p = normalizePage(page)
  if (p) state.page = p
  if (phase) state.phase = phase
  state.lastSeenAt = Date.now()
  persistState()
}

/** 浏览器日志通道：client 上报 → 宿主缓冲 → agent 工具读取；report 即心跳。 */
export class BrowserLogService extends TypertRemoteService {
  static inject = []
  constructor(ctx: Context, cfg: Config) {
    super(ctx, 'browserLogRemote', { namespace: 'browserLog' })
    state.maxLogs = cfg.maxLogs
    state.maxText = cfg.maxText
    loadClientState(process.env.DSH_HOME || '')
  }
  @Remote('report')
  report(req: { logs?: Array<{ t?: number; level?: string; text?: string }>; page?: string }): { ok: boolean } {
    heartbeat(typeof req.page === 'string' ? req.page : '')
    const items = Array.isArray(req.logs) ? req.logs : []
    state.logs = appendLogs(state.logs, items, {
      maxLogs: state.maxLogs, maxText: state.maxText, page: state.page, nowMs: Date.now(),
    })
    return { ok: true }
  }
  @Remote('list')
  list(): { logs: BrowserLog[]; page: string; phase: string; lastSeenAt: number } {
    return { logs: state.logs.slice(-state.maxLogs), page: state.page, phase: state.phase, lastSeenAt: state.lastSeenAt }
  }
  @Remote('clear')
  clear(): { ok: boolean } {
    state.logs = []
    return { ok: true }
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.plugin(BrowserLogService, config)
  loadClientState(process.env.DSH_HOME || '')

  ctx.tools.register(defineTool({
    name: 'browser_console',
    description: '读取浏览器端上报的控制台日志与全局错误（client 插件 hook console + window error/unhandledrejection）。用于排查前端插件加载/运行问题——相当于自己看 F12 Console。',
    parameters: {
      limit: { type: 'number', description: '返回条数（默认 50）' },
      level: { type: 'string', enum: ['error', 'warn', 'info'], description: '按级别过滤' },
      sinceMs: { type: 'number', description: '只看该时间戳（ms）之后的日志' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { count: { type: 'number', required: true }, logs: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } }, page: { type: 'string' }, clientPhase: { type: 'string' }, clientAlive: { type: 'boolean', required: true }, lastSeenAt: { type: 'number' }, lastSeenAgoSec: { type: 'number' } } }, render: (_a: any, v: any) => [{ type: 'text', text: 'client ' + (v.clientAlive ? '存活（' + v.lastSeenAgoSec + 's 前' : (v.lastSeenAt ? '失联（' + v.lastSeenAgoSec + 's 前最后心跳）' : '从未心跳')) + (v.clientPhase ? '，阶段: ' + v.clientPhase : '') + '\n' + (v.page ? '页面: ' + v.page + '\n' : '') + (v.logs as any[]).map((l: any) => '[' + new Date(l.t).toLocaleTimeString() + ' ' + l.level + '] ' + l.text).join('\n') || '(无日志)' }] },
    async execute(args: { limit?: number; level?: string; sinceMs?: number }) {
      const st = { logs: state.logs.slice(-state.maxLogs), page: state.page, phase: state.phase, lastSeenAt: state.lastSeenAt }
      let logs = st.logs
      if (args.level) logs = logs.filter((l) => l.level === args.level)
      if (args.sinceMs) logs = logs.filter((l) => l.t >= (args.sinceMs ?? 0))
      const limited = logs.slice(-(args.limit ?? 50))
      const now = Date.now()
      const clientAlive = st.lastSeenAt > 0 && now - st.lastSeenAt < 60000
      // JSON 往返：确保值可被工具 schema 校验（JsonValue 兼容）
      return JSON.parse(JSON.stringify({ count: limited.length, logs: limited, page: st.page, clientPhase: st.phase, clientAlive, lastSeenAt: st.lastSeenAt, lastSeenAgoSec: st.lastSeenAt ? Math.round((now - st.lastSeenAt) / 1000) : 0 })) as { count: number; logs: Array<Record<string, JsonValue>>; page: string; clientPhase: string; clientAlive: boolean; lastSeenAt: number; lastSeenAgoSec: number }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_page',
    description: '查看浏览器当前页面信息（URL/标题）——client 插件上报的最新页面状态。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { page: { type: 'string' }, clientAlive: { type: 'boolean', required: true }, lastSeenAt: { type: 'number' }, lastSeenAgoSec: { type: 'number' } } }, render: (_a: any, v: any) => [{ type: 'text', text: 'client ' + (v.clientAlive ? '存活' : (v.lastSeenAt ? '失联（' + v.lastSeenAgoSec + 's 前）' : '从未心跳')) + (v.page ? ' | ' + v.page : '') }] },
    async execute() {
      const st = { logs: state.logs.slice(-state.maxLogs), page: state.page, phase: state.phase, lastSeenAt: state.lastSeenAt }
      const now = Date.now()
      const clientAlive = st.lastSeenAt > 0 && now - st.lastSeenAt < 60000
      return { page: st.page, clientAlive, lastSeenAt: st.lastSeenAt, lastSeenAgoSec: st.lastSeenAt ? Math.round((now - st.lastSeenAt) / 1000) : 0 }
    },
  }))

  // client 裸心跳路由（不依赖 Typert remote/mount）：
  // GET /browser/probe?page=...&phase=... → 心跳；
  // POST /browser/probe {logs,page,phase} → 心跳 + 日志（remote report 失败时的兜底通道）。
  ctx.webServer.register({
    kind: 'prefix',
    path: '/browser',
    handler: (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== '/browser/probe') { res.writeHead(404).end(); return }
        if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk: Buffer) => { if (body.length < 1_000_000) body += chunk.toString('utf8') })
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body) as { logs?: Array<{ t?: number; level?: string; text?: string }>; page?: string; phase?: string }
              heartbeat(parsed.page ?? '', parsed.phase ?? '')
              for (const it of parsed.logs ?? []) {
                const level = typeof it.level === 'string' ? it.level : 'info'
                const text = typeof it.text === 'string' ? it.text.slice(0, state.maxText) : String(it.text ?? '')
                if (!text) continue
                state.logs.push({ t: typeof it.t === 'number' ? it.t : Date.now(), level, text, page: state.page })
              }
              if (state.logs.length > state.maxLogs) state.logs.splice(0, state.logs.length - state.maxLogs)
              res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
            } catch (err) { res.writeHead(400).end(String(err)) }
          })
          return
        }
        const page = url.searchParams.get('page') ?? ''
        const phase = url.searchParams.get('phase') ?? ''
        heartbeat(page, phase)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(500).end(String(err))
      }
    },
  })

  ctx.logger('agent-browser').info('dsh-agent-browser 就绪')
}