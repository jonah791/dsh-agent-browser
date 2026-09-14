# 语义文档：浏览器控制台感知（agent browser）

> 版本 v0.1 · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：补课式回填（实现已存在，语义文档事后对齐；后续改动用实践回修）
> 实现落点：`self-plugins/dsh-agent-browser/src/index.ts`（host）· `src/logic.ts`（纯逻辑）· `src/client/index.ts`（浏览器 client）· `src/client/remote.ts`（Typert remote 声明）

| 项 | 值 |
|----|----|
| 能力名 | 浏览器控制台感知 / agent browser（host + client 双面插件） |
| 主副本路径 | `self-plugins/dsh-agent-browser/docs/semantic.md` |
| 实现落点 | `src/index.ts`（194 行）· `src/logic.ts`（119 行）· `src/client/index.ts`（159 行）· `src/client/remote.ts`（35 行） |
| 包名 / 版本 | `dsh-agent-browser` / 0.1.0（`package.json`） |
| 组合行 | `id: agent-agent-browser` · `name: dsh-agent-browser`（`.dsh/profiles/web/cordis.patch.yml:87`，无 config） |
| 状态 | **draft** |

---

## 1 · 定位与反定位

**定位**：让 agent **自己看 F12 Console**——浏览器 client hook `console.error/warn/info` 与全局 `error` / `unhandledrejection`，
批量上报宿主；宿主做环形缓冲，agent 用 `browser_console` / `browser_page` 两个工具读取，用于排查前端插件加载/运行问题。

**反定位（本文不管什么）**：
- **不管自主浏览器操作**：打开页面/点击/截图属于 `webops_*`（dsh-agent-webops）——本插件只**读**浏览器侧信号，不驱动浏览器
- **不管 VLM 看图**：不截图、不做视觉理解（那属于 `dsh-agent-vision`）
- **不是**持久日志系统：日志只在**内存**环形缓冲，web 重启即丢；只有「最近心跳时间 + 页面标识」落盘
- **不是** session/agent 事件观测：不订阅 DSH 会话事件流

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| client 心跳 | 浏览器 client 每 10s 上报一次 `/browser/probe?page=…&phase=…`，驱动宿主 `lastSeenAt` |
| `clientAlive` | `lastSeenAt > 0 && now - lastSeenAt < 60000`（**60s 新鲜度**） |
| `phase` | client 自报阶段：`hooked`（apply 已执行）→ `mounted`（remote mount 成功） |
| 环形缓冲 | 日志数组上限 `maxLogs`（默认 500），超出**保留最新**；单条文本截断 `maxText`（默认 800） |
| 裸心跳路由 | `GET /browser/probe`——**不依赖** Typert remote/mount 的兜底通道 |
| 双通道上报 | remote `browserLog.report`（mounted 后尝试）+ `POST /browser/probe`（一定到 host 的兜底） |
| `normalizePage` | 页面标识归一：非字符串→`''`，超过 `PAGE_MAX=300` 截断 |
| auto-reload | client 每 60s 读页面 `__DSH_BOOT__` 里本 bundle 的 `rev`，变化即 `location.reload()` |

## 3 · 概念模型

```
浏览器页面                                    宿主（web 进程）
┌──────── client/index.ts ────────┐          ┌──────── index.ts ────────┐
│ apply() 即刻装 hook（不依赖 mount）│          │ BrowserLogService         │
│  console.error/warn/info ─┐      │          │  @Remote report/list/clear│
│  window error/unhandled  ─┤push  │          │ state{logs,page,phase,    │
│  600ms 去抖 flush ────────┘      │          │       lastSeenAt}         │
│  双通道：remote report + POST ───┼─ HTTP ──►│ GET/POST /browser/probe   │
│  10s 心跳 GET /browser/probe ────┼─────────►│   heartbeat() → persist   │
│  60s __DSH_BOOT__ rev 比对 ──┐   │          │ tools: browser_console    │
│  rev 变化 → location.reload ◄┘   │          │        browser_page       │
└──────────────────────────────────┘          └───────────────────────────┘
                                                        │
        $DSH_HOME/.browser-client-state.json ◄──────────┘ {lastSeenAt, page}
```

不变量（invariants）：
1. **I1 心跳先于 mount**：client 的裸心跳（`phase=hooked`）在 `ctx.remote.$mount` 之前就开始 —— mount 失败也不影响「在场」判定
2. **I2 坏状态文件不改内存**：`parseClientState` 返回 `null`（损坏/形状不符）时**保持内存态不动**（不用半截数据污染 `lastSeenAt`）
3. **I3 上限硬约束**：缓冲条数 ≤ `maxLogs`，单条文本长度 ≤ `maxText`，`page` 长度 ≤ `PAGE_MAX`
4. **I4 纯逻辑无 IO**：`src/logic.ts` 不读文件、不读时钟（`nowMs` 由调用方注入）、不 import 宿主包
5. **I5 报告不可用于判定「有人在看」**：`heartbeat()` 是**裸入口**，任何 GET 都能推进 `lastSeenAt`（见 §5 失败面与 U1）

## 4 · 契约

### 4.1 落盘状态文件
- 路径：`$DSH_HOME/.browser-client-state.json`（`DSH_HOME` 为空则**不落盘**：`state.stateFile = ''`）
- 形状：`{ "lastSeenAt": <number ms>, "page": <string> }`（写入前 `normalizePage` 截断 300）
- 写入方式：`persistState()` 每次心跳 `writeFileSync` **整文件覆盖**（非原子）；写失败**静默吞**（不影响服务）
- 读取语义：启动时（`BrowserLogService` 构造 + `apply`）各读一次；损坏/形状不符 → 保持内存态（I2）

### 4.2 工具与配置

| 工具 | 参数 | 返回（schema 必填项加粗） | render |
|------|------|--------------------------|--------|
| `browser_console` | `limit?`(number，默认 50) · `level?`(enum `error`\|`warn`\|`info`) · `sinceMs?`(number) | **count** · **logs[]** · page · clientPhase · **clientAlive** · lastSeenAt · lastSeenAgoSec | `client 存活（Ns 前）/失联/从未心跳` + phase + 页面 + 日志行 |
| `browser_page` | 无 | page · **clientAlive** · lastSeenAt · lastSeenAgoSec | `client 存活/失联/从未心跳` + `\| <page>` |

- 插件配置 `Config`：`maxLogs`（number，默认 **500**）· `maxText`（number，默认 **800**）
- dispatch 过滤顺序（`browser_console.execute`）：`level` 过滤 → `sinceMs` 过滤 → `slice(-limit)`；返回前走 `JSON.parse(JSON.stringify(...))` 确保可过 schema 校验

### 4.3 HTTP 路由（`ctx.webServer.register`）

| 方法 | 路径 | 行为 | 非法输入 |
|------|------|------|---------|
| GET | `/browser/probe?page=…&phase=…` | `heartbeat(page, phase)` → `200 {"ok":true}` | 其它路径 → `404`（空 body） |
| POST | `/browser/probe` | 解析 JSON → `heartbeat` + 逐条入缓冲（截断 `maxText`，丢弃空文本） → `200 {"ok":true}` | body 解析失败 → `400`；外层异常 → `500` |
| — | — | 路由注册为 `kind: 'prefix'`, `path: '/browser'`；POST body 最多累积 1_000_000 字符 | — |

### 4.4 裁决（纯函数 · `src/logic.ts`）

| 函数 | 签名 | 裁决 |
|------|------|------|
| `normalizePage` | `(page: unknown) → string` | 非字符串/空 → `''`；否则 `slice(0, 300)` |
| `parseClientState` | `(raw: string) → ClientState \| null` | 空/坏 JSON/非对象/`lastSeenAt` 非有限数/`page` 非字符串 → `null`（调用方保持内存态） |
| `toLogItem` | `(raw, {maxText, page, nowMs}) → LogItem \| null` | 文本空串 → `null`（丢弃）；`level` 非字符串 → `'info'`；`t` 非有限数 → `nowMs` |
| `appendLogs` | `(existing, incoming, opts) → LogItem[]` | 合并后 `length > maxLogs` → 保留**最新** `maxLogs` 条；不修改入参 |
| `isClientFresh` | `(lastSeenAt, nowMs, ttlMs) → boolean` | 非有限数 / `lastSeenAt<=0` / **未来时间戳**（时钟偏移）→ `false`（fail-closed） |

### 4.5 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web 组合 | `.dsh/profiles/web/cordis.patch.yml:87`（`insert: [{id: agent-agent-browser, name: dsh-agent-browser}]`） | web 启动装载 |
| 宿主装载 | `src/index.ts:115` `apply(ctx, config)` → `ctx.plugin(BrowserLogService, config)` + `loadClientState(process.env.DSH_HOME \|\| '')` | 插件激活 |
| 宿主工具面 | `src/index.ts:119` `ctx.tools.register(defineTool({name:'browser_console'}))` · `src/index.ts:141`（`browser_page`） | `apply()` 时各注册一次 |
| 宿主路由 | `src/index.ts:157` `ctx.webServer.register({kind:'prefix', path:'/browser', handler})` | `apply()` 时注册一次 |
| 宿主 service | `src/index.ts:87-113` `BrowserLogService`（`namespace: 'browserLog'`，`static inject = []`）方法 `report(req)` / `list()` / `clear()` | 由 remote 调用 / 内部读取 |
| client 声明 | `src/client/remote.ts:27` `TYPERT_REMOTE`：descriptor id `dsh-agent-browser#browserLog/report` 与 `…#browserLog/clear`（`service: 'browserLogRemote'`, `namespace: 'browserLog'`, `invocation.kind: 'direct'`） | client bundle 加载时导出 |
| client 装载 | `src/client/index.ts:11` `export const inject = ['remote']`；`:33` `apply(ctx: ClientContext)` | 浏览器内由 HMR 注入 |
| client hook | `src/client/index.ts:93-95` `console.error/warn/info` 包装；`:97` `window.addEventListener('error')`；`:101` `'unhandledrejection'` | `apply()` 立即（不依赖 mount） |
| client 心跳 | `src/client/index.ts:37` `probe()` → `fetch('/browser/probe?page=…&phase=…')`，`:42` `setInterval(…, 10000)` + 立即一次 | 每 10s |
| client 上报 | `src/client/index.ts:58` `flush()`：`ctx.remote.browserLog.report({logs})`（`mounted` 时）+ `fetch('/browser/probe', {method:'POST', body:{logs,page,phase}})`；`:141` `setInterval(flush, 2000)`；`push` 600ms 去抖，缓冲上限 80 | 每 2s / 600ms 去抖 |
| client auto-reload | `src/client/index.ts:116` `autoReload()` 读 `window.__DSH_BOOT__.entries` 中 `id === 'dsh-agent-browser'` 的 `rev`，与 `CURRENT_REV` 不等 → `location.reload()`；`:131` `setInterval(…, 60000)` | 每 60s |
| 纯逻辑 | `src/logic.ts` `normalizePage` / `parseClientState` / `toLogItem` / `appendLogs` / `isClientFresh` ← 被 `src/index.ts:17` 与 `tests/logic.test.mjs` 调用 | 每次心跳/上报/读取 |
| auto-reload 依赖 | `window.__DSH_BOOT__`（由宿主 web shell 注入，含 `entries[].{id,url,rev}`） | 页面加载时 |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：client 侧 hook 只包装 `console.error/warn/info`（**不含 `console.log`**——README 写的 `console.log` 与源码不符，见 §9 修正）。宿主侧无鉴权：`/browser/probe` 任何同源请求都能写入心跳与日志。
- **不越界清单**：不驱动浏览器（不点击/不导航/不截图）· 不落盘日志正文（只落 `lastSeenAt`/`page`）· 不做日志脱敏（页面 URL 与错误文本原样入缓冲，可能含路径/查询串）· 不跨会话共享（缓冲是进程级模块状态）。
- **失败面**：
  - 状态文件缺失/损坏 → **放行**：`readFileSync` 失败或 `parseClientState→null` 一律保持内存态，不抛、不覆盖
  - 状态文件写入失败 → **放行**：`catch {}` 静默（`/* 持久化失败不影响服务 */`）
  - client POST 失败（host 未就绪） → **放回缓冲重试**（去重合并，`reportAttempts += 1`），不丢日志
  - remote `report` 失败 → 静默降级到 POST 兜底（不报错给页面）
  - 路由非法路径 → `404`；body 坏 → `400`；handler 抛错 → `500`（**拒绝 + 报错**，不静默）
  - **假在场风险（实测）**：`GET /browser/probe` 会直接推进 `lastSeenAt`——**agent 自己发一次 GET 就能把 `clientAlive` 抬成 true**（2026-09-14 实测：一次手工 GET 把状态文件 `page` 写成 `alice-check`、`lastSeenAt` 更新为当前时刻）。即 `clientAlive` 是「通道被碰过」的证据，不是「有人在看页面」的证据。

## 6 · 与既有机制的关系

- **与 `webops_*`（dsh-agent-webops）**：互补——webops 是**行动**（headless 驱动浏览器），本插件是**感知**（读真实浏览器控制台）。排查前端插件问题时应先 `browser_console` 看真实页面报错，再用 webops 复现。
- **与 AGENTS.md §5.22（可维护性）**：本插件**没有**侧车轨迹文件；`phase`/`clientAlive` 就是它的自证层（`browser_page` 一条命令可答「client 是否在场、处在哪个阶段」）。
- **与 §5.12 / §5.18（投递与在场纪律）**：`isClientFresh` 明确采用「可验证时间证据、不用代理量」的判据，并对**未来时间戳** fail-closed。
- **与组合变更 / preflight**：client bundle（`lib/client.js`，tsdown 产物）与 host 产物（`lib/index.js`，tsc）是**两条构建链**；只重建 host 不会更新浏览器侧代码 → 改 client 必须重建 `lib/client.js`，且浏览器要等 auto-reload 的 rev 变化才会加载新 bundle。
- **与哨兵协议**：`lib/*.js` 变新会触发 `hasUnverifiedBuilds()` → 重启需走 `preflight_check` + 哨兵；本插件不例外。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（命令 / HTTP / 测试名） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 插件已挂载进 web 组合 | `Select-String -Path E:\alice\.dsh\profiles\web\cordis.patch.yml -Pattern 'agent-browser'` → 命中 87-88 行 | **已实测**（2026-09-14） |
| A2 | 裸心跳路由在线 | `Invoke-WebRequest 'http://127.0.0.1:3080/browser/probe?page=alice-check&phase=probe'` → **HTTP 200** `{"ok":true}` | **已实测**（2026-09-14） |
| A3 | 非 `/browser/probe` 路径返 404 | `Invoke-WebRequest 'http://127.0.0.1:3080/browser/nope'` → **HTTP 404** | **已实测**（2026-09-14） |
| A4 | 心跳落盘 | `E:\alice\.dsh\.browser-client-state.json` 存在，内容 `{lastSeenAt, page}`，mtime 随心跳前进（实测 mtime `2026-09-14T10:13:02`） | **已实测** |
| A5 | 纯逻辑有回归网且全绿 | `cd self-plugins/dsh-agent-browser && node --test "tests/*.test.mjs"`（`tests/logic.test.mjs`） | **待验收**（本轮禁跑测试） |
| A6 | 环形上限成立 | 断言 `appendLogs(existing, incoming, {maxLogs: 3})` 返回长度 ≤ 3 且为最新 3 条 | 待验收（应落在 A5 测试名内） |
| A7 | 坏状态文件不污染内存 | 喂 `parseClientState('{"lastSeenAt":"x"}')` → `null`；`loadClientState` 后 `state.lastSeenAt` 不变 | 待验收 |
| A8 | 真实浏览器 client 在场 | 调 `browser_page` → `clientAlive: true` 且 `page` 含真实 URL（非 agent 自造串） | 待验收 |
| A9 | 前端错误可被读到 | 在页面 console 里 `console.error('probe-x')` → `browser_console({level:'error'})` 的 logs 含 `probe-x` | 待验收 |
| A10 | 改了代码后确实生效 | 见下方「生效判据」① ② ③ | 待验收 |
| A11 | **已知陈旧产物** | `lib/client.js` mtime `2026-08-16 15:14:37` vs `lib/index.js` mtime `2026-09-13 07:23:23` → client bundle 落后 host 构建 28 天（若期间改过 `src/client/**`，则线上浏览器侧跑的是旧代码） | **已实测**（2026-09-14，需人工核对 `src/client` 改动史） |

**生效判据（S7）**：改代码后逐条取证——
① **host**：`lib/index.js` 的 mtime **晚于** web 进程启动时间，且 web 进程启动时间 **晚于**该 mtime（重建 ≠ 生效，见 AGENTS.md §5.11 §6）；
② **路由**：`GET /browser/probe?page=probe` 返 `200 {"ok":true}`（A2）——路由在响应即证 host 新代码在跑；
③ **client**：改 `src/client/**` 必须重建 `lib/client.js`（tsdown，见 `tsdown.config.ts`，产物 `lib/client.js`），然后**刷新页面或等 auto-reload**（rev 比对），最后用 `browser_page` 看 `clientPhase`：`hooked` → `mounted` 才算 client 新代码生效。
只看 ① 而声称「整个插件生效」是错的（client 面独立）。

**回退（S7）**：
① 代码回退：`git -C E:\alice\self-plugins\dsh-agent-browser revert <坏提交>`（或 `git checkout <上一提交> -- src/`）→ 重建 host（`tsc`）**与 client（tsdown）**→ 走 `preflight_check` + 哨兵重启；
② 能力回退：`plugin_stop dsh-agent-browser`（临时）或 `plugin_unmount`（摘除 `agent-agent-browser` 行）→ 工具与 `/browser` 路由同时消失；
③ 状态回退：删除 `$DSH_HOME/.browser-client-state.json`——**安全**（首次运行路径，`readFileSync` 失败即从零开始），代价只是丢失 `lastSeenAt`。

## 8 · 与实现的关系

- 主实现：`src/index.ts`（host 装载/工具/路由/service）· `src/logic.ts`（纯逻辑，无 IO）· `src/client/index.ts`（浏览器 hook + 上报）· `src/client/remote.ts`（Typert remote 描述符）
- 构建产物（**两条链**）：`lib/index.js` + `lib/logic.js` + `lib/types/*`（`tsc -p tsconfig.json`）；`lib/client.js`（tsdown，`banner` 注入 `window.__ModuleLoader__.load({ id: 'dsh-agent-browser' … })`）
- 同语义副本：无（本文件是唯一主副本）
- 未实现 / 未验证部分（**显式标注**）：
  - `BrowserLogService.list()` 存在于宿主 service，但 client remote 只声明了 `report` / `clear`（`src/client/remote.ts:30-31`）——`list` 目前无 client 调用方
  - README 宣称 hook「console.log/warn/error」，源码实际是 `error/warn/info`（§9 修正）
  - `lib/client.js` 落后于 host 构建（A11），未验证线上 client 是否等于 `src/client` 当前代码

## 9 · 实践修订记录

- 2026-09-14 补课：本插件此前无语义文档（可维护性工程）
- 2026-09-14 补课
  - 语义**被确认**：双面插件的契约核心是「两条通道 + 两条构建链」——裸心跳路由 `/browser/probe`（不依赖 mount）与 remote `browserLog.report`（mounted 后）；host `lib/index.js`（tsc）与 client `lib/client.js`（tsdown）独立构建
  - 语义**被补充**：写入「生效判据」三条（host 产物 vs 进程启动时间 / 路由 200 / client phase `hooked→mounted`）与「回退」三条（git revert + 双链重建 / plugin_stop / 删状态文件）
  - 语义**被修正**：① README 的 `console.log` 与源码 `console.info` 不符——以**源码**为准（hook 的是 `error/warn/info`）；② 实测发现 `clientAlive` 可被 agent 自己的 GET 抬成 true（假在场风险），已把「判据语义」写进 §3 I5 与 §5 失败面
  - 教训：**感知类插件的自证通道本身就是它最容易自欺的地方**——`/browser/probe` 既是兜底通道又是可被伪造的在场证据；判「client 在场」时应同时看 `phase`（`hooked`/`mounted`）与 `page` 内容是否像真实页面

## 10 · 未决问题

- **U1 `clientAlive` 假在场**：裸 GET 即推进 `lastSeenAt`。倾向：区分「裸心跳」与「带日志/带 page 的真实上报」，或在状态里记录 `lastLogAt` / `lastPageAt`，`clientAlive` 改用后者。需实现者裁决。
- **U2 日志无脱敏**：页面 URL 与错误栈原样入缓冲并可被工具读出（可能含路径、查询串）。倾向：`maxText` 之外增加可配置的脱敏钩子，或至少在文档层声明「日志可能含敏感串，勿直接外发」。需裁决。
- **U3 client bundle 陈旧监测**：A11 现象（`lib/client.js` 落后 28 天）没有任何机制会自动发现。倾向：把 `client.js` mtime 纳入 `preflight_check` 的 `hasUnverifiedBuilds()` 判定面，或在 `browser_page` 输出里加 `clientBuildAt`。需裁决（属预检插件的改动）。
- **U4 `BrowserLogService.list()` 无调用方**：是给未来 client 读日志用，还是死代码？倾向：保留（诊断面），但补一句注释说明用途。
- **U5 状态文件非原子写**：`writeFileSync` 直写，断电可能留半截文件——已有 I2 兜底（损坏即忽略），故倾向「接受现状 + 明确记录」，不再加临时文件重命名。
