<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 浏览器控制台感知（host + client 双面插件）：浏览器 client hook console.error/warn/info + window error/unhandledrejection，
           批量上报宿主；宿主环形缓冲，agent 用 browser_console / browser_page 读取——自己看 F12 Console
  inject: 'tools','webServer'（host）· 'remote'（client 面）
  tools: browser_console,browser_page
  runtime: host + client（client 产物 lib/client.js 经宿主的 __ModuleLoader__ 注入浏览器）
  envDeps: 无（标准 Node）；client 面依赖宿主 web shell 注入 window.__DSH_BOOT__（auto-reload 用，缺失不影响 hook 与上报）
  boundary: /browser/probe 无鉴权——任何同源请求都能推进 lastSeenAt，故 clientAlive 可被 agent 自己的 GET 抬成 true（假在场风险，见「设计要点」）
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6 / dsh-client-runtime ^0.1.0-rc.6 / dsh-host-webserver 0.1.0-rc.6 / dsh-typert-protocol ^0.1.0-rc.6 / schemastery ^3.18.1-rc.1 / react ^18.2.0
-->
# dsh-agent-browser

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-browser"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-22%20passed-brightgreen" alt="tests">
</p>

**一句话**：让 agent **自己看 F12 Console**——浏览器侧 client 把 `console.error/warn/info` 与 `window error` / `unhandledrejection` 批量上报宿主，宿主做内存环形缓冲，agent 用 `browser_console` / `browser_page` 两个工具读取。

**为什么值得用**：前端插件加载/运行出问题时，症状只存在于**浏览器**里（页面白屏、插件静默不生效、chunk 加载失败），宿主的日志与事件流完全看不到。不用它，排查只能靠「让用户开 F12 念报错」；用了它，`browser_console({level:'error'})` 一条调用就拿到真实页面的报错原文，`browser_page` 还能回答「client 到底加载到哪一步（`hooked` / `mounted`）+ 多久没心跳」。这是**感知**面：只读浏览器侧信号，不驱动浏览器。

## 能力

| 工具 | 用途 |
|------|------|
| `browser_console` | 读取浏览器端上报的控制台日志与全局错误（client 插件 hook console + window error/unhandledrejection）。参数：`limit`（默认 50）、`level`（`error`\|`warn`\|`info`）、`sinceMs`。过滤顺序 = `level` → `sinceMs` → `slice(-limit)`；返回 `count` / `logs[]` / `page` / `clientPhase` / `clientAlive` / `lastSeenAt` / `lastSeenAgoSec` |
| `browser_page` | 查看浏览器当前页面信息（URL/标题）——client 上报的最新页面状态。返回 `page` / `clientAlive` / `lastSeenAt` / `lastSeenAgoSec` |

行为侧（无工具）：

| 面 | 行为 |
|----|------|
| client hook | `apply()` **一执行就装 hook**（不依赖 remote mount）：包装 `console.error` / `console.warn` / `console.info`（**不含 `console.log`**）+ 监听 `window` 的 `error` / `unhandledrejection`；push 后在 **600ms 去抖**内 flush，本地缓冲上限 80 条、单条文本截断 600 字符 |
| client 上报（双通道） | mount 成功后走 remote `browserLog.report`；**同时**走 `POST /browser/probe` 兜底（remote 失败静默降级，POST 失败则把批次放回缓冲重试——不丢日志）。周期：flush 每 2s、页面信息每 10s |
| client 心跳 | 每 10s `GET /browser/probe?page=<href \| title>&phase=<hooked\|mounted>`，驱动宿主 `lastSeenAt`；`phase` 表示 client 加载阶段 |
| client auto-reload | 每 60s 比对页面 `window.__DSH_BOOT__` 里本 bundle 的 `rev`，变化即 `location.reload()`（宿主更新 client bundle 后，浏览器无需手动刷新） |
| host 路由 | `GET /browser/probe` → 心跳 + `200 {"ok":true}`；`POST /browser/probe` → 心跳 + 逐条入缓冲 + `200`；非法路径 `404`、body 坏 `400`、handler 抛错 `500` |
| host 状态 | 模块级环形缓冲 `{logs, page, phase, lastSeenAt}`，`maxLogs`/`maxText` 由配置约束；只有「最近心跳时间 + 页面标识」落盘 |

**反定位**（本插件不做什么）：
- **不驱动浏览器**：打开页面 / 点击 / 截图属 `webops_*`（dsh-agent-webops）——本插件只读信号
- **不做视觉理解**：不截图、不喂 VLM（属 `dsh-agent-vision`）
- **不是持久日志系统**：日志只在内存环形缓冲，web 重启即丢；不落盘日志正文、不做脱敏
- **不订阅 DSH 会话事件**：与 session/agent 事件流无关

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-browser": "link:<工作区>/self-plugins/dsh-agent-browser"
```

**2) 挂组合**（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: agent-agent-browser
      name: dsh-agent-browser
```

**3) 30 秒验证**（按顺序做，三条都对才算挂好了）：

1. 工具面出现 `browser_console` / `browser_page`（`plugin_list` 或工具列表可见）；
2. `GET http://127.0.0.1:3080/browser/probe?page=probe` → `200 {"ok":true}`（路由在响应即证 host 侧装载）；
3. 调 `browser_page` → 期望 `clientAlive: true` 且 `page` 形如 `<真实页面 URL> | <标题>`；调 `browser_console` 应能读到 `[agent-browser] console hook 已启用（browser_console 可读）` 这条 info（client 自己写的，是「hook 真的装上了」的现成证据）。

> ⚠ 步骤 2 的那次 GET **会推进 `lastSeenAt`**（路由无鉴权）——用它验证完路由后，别立刻把步骤 3 的 `clientAlive: true` 当作「真有页面在看」。看 `page` 内容是否像真实 URL（而非你手写的探针串）与 `clientPhase` 是否到 `mounted` 才是更强的证据。

## 配置

插件配置 `Config`（`src/index.ts`）：

| 项 | 默认 | 说明 |
|----|------|------|
| `maxLogs` | `500` | 日志环形缓冲条数上限；超出**保留最新**的前 N 条（`0` = 不缓冲） |
| `maxText` | `800` | 单条文本截断长度（host 侧入缓冲时截断） |

**不可配置项**（源码常量，改需改代码）：

| 常量 | 值 | 位置 / 含义 |
|------|----|------------|
| client 心跳周期 | `10000` ms | `src/client/index.ts` `setInterval(probe, 10000)` |
| client flush 周期 | `2000` ms | mount 成功后 `setInterval(flush, 2000)` |
| push 去抖 | `600` ms | 一条日志到一次 flush 的等待 |
| client 本地缓冲 | `80` 条 / 单条 `600` 字符 | 上报前的本地队列与截断 |
| page 长度上限 | `PAGE_MAX = 300` | `src/logic.ts`，`normalizePage` 截断（title 另截 100） |
| `clientAlive` TTL | `60000` ms | 判据硬编码在 `browser_console.execute`/`browser_page.execute`：`lastSeenAt > 0 && now - lastSeenAt < 60000` |
| auto-reload 周期 | `60000` ms | 读 `__DSH_BOOT__.entries[].rev` 比对 |
| POST body 上限 | `1_000_000` 字符 | `/browser/probe` 累积上限 |

> 注意：`isClientFresh(lastSeenAt, nowMs, ttlMs)`（`src/logic.ts`）是带 TTL 参数的**纯函数**判据（对被单测覆盖），但**工具执行路径并未调用它**——工具里的 60s 判据是就地硬编码的。改 TTL 时两处要一致。

## 落盘与自证（出问题时先看这里）

**本插件没有 `<DSH_HOME>/<x>-trace.jsonl` 侧车轨迹**（已知可维护性缺口，见 [`docs/semantic.md`](docs/semantic.md) §6/§10）。它的自证层是**行为级**的：`phase` + `clientAlive` + 心跳状态文件。

**唯一持久产物**：`${DSH_HOME}/.browser-client-state.json`（`DSH_HOME` 为空则**不落盘**）——它不是阶段轨迹，而是**心跳快照**，每次心跳整文件覆盖（非原子写，坏文件有兜底：解析失败一律忽略，不用半截数据污染内存态）：

| 字段 | 含义 |
|------|------|
| `lastSeenAt` | 最后一次任何形式心跳的时刻（ms）——`clientAlive` 的唯一输入 |
| `page` | 最近一次上报的页面标识（已 `normalizePage` 截断 300） |

配套的可读信号在 `browser_page` / `browser_console` 的返回里：`clientPhase`（`hooked` = client `apply` 已执行 → `mounted` = remote mount 成功）、`clientAlive`（60s 新鲜度）、`lastSeenAgoSec`（自报时差）。

**一条命令答五问**（本插件只答得全 ③④⑤，①②见注）：

```bash
cat "$DSH_HOME/.browser-client-state.json"; ls -l --time-style=+%Y-%m-%dT%H:%M:%S lib/client.js lib/index.js
# ① 跑的是哪个构建   → 文件里没有 build 字段（缺口）；改看 mtime 对照：lib/*.js 的 mtime vs web 进程启动时间
# ② 谁发起           → 无 caller 字段（缺口）；用 browser_page 的 page 内容反推是真实页面还是探针
# ③ 断在哪一段       → phase 枚举：无文件（client 从未加载 / DSH_HOME 为空）→ hooked（apply 执行了但 mount 失败）→ mounted（全链路通）
# ④ 结果质量         → page 是否像真实 URL、lastSeenAt 是否在 60s 内前进（停滞 = client 掉线或页面关了）
# ⑤ 耗时与预算       → mtime 的推进间隔应 ≈ 心跳周期 10s；明显更疏 ⇒ 心跳在丢
```

行为级验证（无需落盘）：页面里手动 `console.error('probe-x')` → `browser_console({level:'error'})` 的 `logs` 应含 `probe-x`。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. **host 进程级**：`lib/index.js` 的 mtime ≤ web 进程启动时间，且 `src/**` 不新于 `lib/index.js`（源码改了没构建 = 跑的还是旧产物）；配合 `plugin_boot_status`（`dsh-plugin-bootreport`）看本插件是否在 `liveNow` 里；
2. **路由语义级**：`GET /browser/probe?page=probe` 返 `200 {"ok":true}`（路由在响应即证新 host 代码在跑）；
3. **client 面独立判据**（改了 `src/client/**` 时必须单独走）：重建 client bundle → **刷新页面或等 auto-reload**（rev 比对）→ 用 `browser_page` 看 `clientPhase` 从 `hooked` 走到 `mounted`。

> ⚠ **重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，要**进程启动时间晚于产物 mtime**才算「在跑它」（AGENTS §5.11 §6）。另：**host 与 client 是两条构建链**——`lib/index.js`（tsc）与 `lib/client.js`（tsdown）独立；只 `npm run build` 不会更新浏览器侧代码，只看 ① 就声称「整个插件生效」是错的。**已知现状**：`tsdown` 没有 npm script 包装（`npm run build` = `tsc` 仅 host），重建 client 需显式跑 tsdown。

**回退**（三档）：

- **源码级**：`git -C self-plugins/dsh-agent-browser revert <坏提交>`（或 `git checkout <上一提交> -- src/`）→ 重建 host（`tsc`）**与 client（tsdown）** → `preflight_check` → 哨兵重启。`lib/*.js` 变新会触发 `hasUnverifiedBuilds()`，本插件不例外；
- **组合级**：profile patch 给 `agent-agent-browser` 行加 `disabled: true`（或 `plugin_stop dsh-agent-browser`）→ 两个工具与 `/browser` 路由**同时消失**，浏览器 client 的上报全部落空（页面照常运行，只是没人听）；
- **运行期**：无持久业务状态。删 `${DSH_HOME}/.browser-client-state.json` **是安全的**（首次运行路径，读失败即从零开始），代价只是丢失 `lastSeenAt`（下次心跳重建）。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"
```

**22 例，全绿**（`# tests 22 / # suites 5 / # pass 22 / # fail 0`，实测于本次重写）。测试**跑的是构建产物**——`tests/logic.test.mjs` 从 `../lib/logic.js` 导入，所以改 `src/logic.ts` 后必须先 `npm run build` 再测（`npm test` 本身不含构建）。

覆盖范围（`tests/logic.test.mjs`，5 个 suite 全部对准 `src/logic.ts` 纯函数）：

| suite | 覆盖 |
|-------|------|
| `normalizePage` | 常规；边界（恰好 `PAGE_MAX` 不截断 / 超一字符即截断）；**尸体**（非字符串 → `''`，不写 `"undefined"`）；空串语义 |
| `parseClientState` | 合法 JSON；前向兼容（多余字段忽略）；**尸体**（坏 JSON / 空内容 / 非对象 → `null`）；字段缺失或类型不符 → `null` |
| `toLogItem` | 字段齐全；缺省填充（level→`info`、t→注入 `nowMs`）；边界（text 恰好 `maxText`）；**尸体**（空串丢弃、纯空白保留、非字符串 `String()` 化、`NaN` 时间戳回落） |
| `appendLogs` | 追加返回新数组；**上限保留最新 N 条**；不可变（不改入参）；**尸体**（`incoming` 非数组不抛）；边界（`maxLogs=0` 清空） |
| `isClientFresh` | 常规与闭区间边界；过期；**尸体**（未来时间戳 → `false`，fail-closed）；零/负/`NaN` 不抛 |

**无需网络、无需真实浏览器**（纯函数离线测）。**未覆盖**：`apply(ctx)` 接线（路由注册、工具注册、`BrowserLogService`）、client bundle 行为（hook 安装 / mount / auto-reload）——即「纯逻辑有回归网，接线层只有行为级验收（见「生效判据」③）」。

## 设计要点

- **双通道上报，兜底不依赖 mount**：remote `browserLog.report` 只在 mount 成功后可用，而「mount 失败」正是最需要日志的时刻——所以 client 无论 mount 与否都走 `POST /browser/probe`。**心跳先于 mount**（`phase=hooked`）是核心不变量：client 在场与否不该被 mount 成败绑架。
- **`clientAlive` 是「通道被碰过」而非「有人在看页面」**：`/browser/probe` 无鉴权，任何同源 GET 都会推进 `lastSeenAt`——agent 自己发一次 GET 就能把 `clientAlive` 抬成 `true`（2026-09-14 实测）。判「client 在场」请同时看 `phase` 与 `page` 内容是否像真实页面。这是已知语义缺口（[`docs/semantic.md`](docs/semantic.md) §10 U1）。
- **坏状态文件不改内存**：`parseClientState` 返回 `null`（损坏 / 形状不符）时**保持内存态不动**——半截数据比没有数据更危险，会把「上次在场时间」污染成错值。写盘失败一律静默吞，不影响服务。
- **失败方向是「回退重试」而非「丢数据」**：POST 失败把批次**放回缓冲**（去重合并）等下一轮；remote 失败静默降级到 POST。反过来，非法路由/坏 body 是**响亮拒绝**（`404`/`400`/`500`），不静默。
- **两条构建链 / 两种注入**：host 走 tsc 产物；client 走 tsdown 打成 CJS，用 `banner` 包成 `window.__ModuleLoader__.load({ id: 'dsh-agent-browser', factory })` 注入浏览器——**跨层不变量不得下移**，改 client 必须重建 `lib/client.js` 并等 rev 变化（auto-reload）才在真实页面生效。
- **环形上限是硬约束**：条数 ≤ `maxLogs`、单条 ≤ `maxText`、`page` ≤ `PAGE_MAX`——浏览器侧的错误文本可能极长（堆栈），不设限会撑爆进程内存与状态文件。
- **反定位要点**：不是持久日志系统（重启即丢、不落正文、不脱敏——页面 URL 与错误栈原样可被工具读出，勿直接外发）。
- **已知债务**：① 工具内 60s TTL 与 `logic.ts` 的 `isClientFresh` 判据**双份实现**（真源不唯一）；② `BrowserLogService.list()` 无 client 调用方；③ `lib/client.js` 构建产物（mtime `2026-08-16`）落后 `lib/index.js`（`2026-09-13`）约 28 天，**当前无法自动发现**（尚无 `src/client` 改动史核对结论）——三条均记在 [`docs/semantic.md`](docs/semantic.md) §10。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语表、概念模型与不变量（I1–I5）、契约（工具/路由/纯函数/调用点清单）、边界与信任、可证伪验收清单（A1–A11）、生效判据与回退、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `plugin-maintainability` / `dsh-plugin-development` | 机制自证与可维护性工程、DSH 插件开发方法论（含 host/client 双面形态选择） |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
