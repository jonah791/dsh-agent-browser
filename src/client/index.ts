/**
 * 浏览器工具 client：hook console + window 全局错误 → 批量上报宿主（browserLog remote）。
 * hook 在 apply 最前面安装（不依赖 remote 就绪）；上报带重试，remote 就绪后自动补报。
 * @module dsh-agent-browser/client
 */
// 0.1.7 契约：聚合包 `dsh-client-runtime/client` 已被上游移除；ClientContext 回到属主 @deepseek-ai/cordis
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: declares `ctx.remote`（RemoteRegistry）on the client Context —— 与官方 ui-plugin-manager 同款写法。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import TYPERT_REMOTE from './remote.ts'

export { TYPERT_REMOTE }

export const inject = ['remote'] as const

declare global {
  interface Window {
    __DSH_BOOT__?: {
      rev?: string
      entries?: Array<{ id: string; url: string; rev: string }>
    }
  }
}

/** 本 bundle 的 rev（boot manifest 注入）——auto-reload 比对基准。 */
const CURRENT_REV: string = (() => {
  try {
    const boot = window.__DSH_BOOT__
    const entry = boot?.entries?.find((e) => e.id === 'dsh-agent-browser')
    return entry?.rev ?? ''
  } catch { return '' }
})()

interface PendingLog { t: number; level: string; text: string }

export function apply(ctx: ClientContext): void {
  // 裸心跳（不依赖 remote/mount）：apply 一执行就开始上报——host 侧 clientAlive 由它驱动。
  // phase=hooked 表示 apply 已执行；mount 成功后切 phase=mounted（诊断 client 加载状态）。
  let phase: 'hooked' | 'mounted' = 'hooked'
  const probe = async () => {
    try {
      await fetch('/browser/probe?page=' + encodeURIComponent((location.href.slice(0, 300) + ' | ' + document.title.slice(0, 100))) + '&phase=' + phase, { cache: 'no-store' })
    } catch { /* host 未就绪：下一轮重试 */ }
  }
  setInterval(() => { void probe() }, 10000)
  void probe()

  const buffer: PendingLog[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let mounted = false
  let pageSent = false
  let reportAttempts = 0
  const maxBuffer = 80

  const push = (level: string, text: string) => {
    buffer.push({ t: Date.now(), level, text: text.slice(0, 600) })
    if (buffer.length > maxBuffer) buffer.splice(0, buffer.length - maxBuffer)
    if (timer === null) timer = setTimeout(() => { void flush() }, 600)
  }

  const flush = async () => {
    timer = null
    if (buffer.length === 0) return
    const batch = buffer.splice(0)
    // 双通道：remote report（mounted 时尝试，失败静默）+ 裸 POST 兜底（一定到 host）
    if (mounted) {
      try { await ctx.remote.browserLog.report({ logs: batch }); reportAttempts = 0 } catch { /* remote 通道失败：POST 兜底 */ }
    }
    try {
      await fetch('/browser/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ logs: batch, page: (location.href.slice(0, 300) + ' | ' + document.title.slice(0, 100)), phase }),
      })
    } catch {
      // POST 失败（host 未就绪）：放回缓冲（去重合并），稍后重试
      buffer.unshift(...batch)
      if (buffer.length > maxBuffer) buffer.splice(0, buffer.length - maxBuffer)
      reportAttempts += 1
    }
  }

  const fmt = (args: unknown[]): string =>
    args.map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.message + (a.stack ? '\n' + a.stack.split('\n').slice(0, 4).join('\n') : '')
      try { return JSON.stringify(a) } catch { return String(a) }
    }).join(' ')

  // —— hook 前置（不依赖任何 remote 状态）——
  const orig = {
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
  }
  console.error = (...args: unknown[]) => { push('error', fmt(args)); orig.error(...args) }
  console.warn = (...args: unknown[]) => { push('warn', fmt(args)); orig.warn(...args) }
  console.info = (...args: unknown[]) => { push('info', fmt(args)); orig.info(...args) }

  window.addEventListener('error', (e) => {
    const ev = e as ErrorEvent
    push('error', '[window.error] ' + ev.message + ' @ ' + (ev.filename ?? '') + ':' + (ev.lineno ?? ''))
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = (e as PromiseRejectionEvent).reason
    push('error', '[unhandledrejection] ' + (r instanceof Error ? r.message : String(r)))
  })

  // 页面信息 + 心跳（周期上报；host 以此判定 clientAlive）
  const reportPage = async () => {
    try {
      await ctx.remote.browserLog.report({ page: location.href.slice(0, 300) + ' | ' + document.title.slice(0, 100) })
      pageSent = true
    } catch { /* remote 暂不可用：下一轮重试 */ }
  }

  // bundle 自动重载（主人无感）：周期读页面 manifest 的 rev，变化即刷新。
  // 宿主更新 client bundle 后 rev 变化，本页自动重载加载新 bundle。
  const autoReload = async () => {
    try {
      const html = await (await fetch(location.pathname + '?clientprobe=' + Date.now(), { cache: 'no-store' })).text()
      const m = html.match(new RegExp('__DSH_BOOT__\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*<\\/script>'))
      if (!m) return
      const raw = m[1]
      if (raw === undefined) return
      const boot = JSON.parse(raw) as { entries?: Array<{ id: string; rev: string }> }
      const entry = boot.entries?.find((e) => e.id === 'dsh-agent-browser')
      if (entry && entry.rev && entry.rev !== CURRENT_REV) {
        // 新 bundle 就绪：自动刷新加载
        location.reload()
      }
    } catch { /* 网络/解析失败：下一轮再试 */ }
  }

  // —— auto-reload（独立于 mount：bundle 更新后自动刷新）——
  setInterval(() => { void autoReload() }, 60000)

  // —— mount + 周期上报 ——
  void (async () => {
    try {
      await ctx.remote.$mount(TYPERT_REMOTE)
      mounted = true
      phase = 'mounted'
      console.info('[agent-browser] console hook 已启用（browser_console 可读）')
      void reportPage()
      setInterval(() => { void flush() }, 2000)
      setInterval(() => { void reportPage() }, 10000)
    } catch (err) {
      console.error('[agent-browser] init fail:', err)
      // 重试 mount（host 重启/时序问题后自动恢复）
      setTimeout(() => { void (async () => {
        try {
          await ctx.remote.$mount(TYPERT_REMOTE)
          mounted = true
          phase = 'mounted'
          console.info('[agent-browser] mount 重试成功')
          void reportPage()
          setInterval(() => { void flush() }, 2000)
          setInterval(() => { void reportPage() }, 10000)
        } catch { /* 继续等下一轮 */ }
      })() }, 5000)
    }
  })()
}
