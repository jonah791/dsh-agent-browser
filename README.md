<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 浏览器工具插件：client 捕获 console/全局错误上报宿主，agent 用 browser_console 工具读取——自己看 F12 Console。
  inject: 'tools','webServer'
  tools: browser_console,browser_page
  runtime: host + client
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-browser — 浏览器控制台感知插件

DSH（DeepSeek Harness）插件：让 agent 能够「自己看 F12 Console」——hook 浏览器端的 console 日志与全局错误，批量上报宿主，agent 通过工具读取，用于排查前端插件加载/运行问题。

## 功能特性

- **浏览器端 hook**：console.log/warn/error + window error / unhandledrejection 捕获，批量上报
- **host 环形缓冲**：日志内存缓冲，agent 可随时读取
- **browser_console 工具**：按级别/时间过滤读取控制台日志
- **browser_page 工具**：查看当前页面 URL/标题与客户端心跳

## 安装

```bash
cd <你的 self-plugins 目录>
git clone https://github.com/jonah791/dsh-agent-browser.git
cd dsh-agent-browser
pnpm install
pnpm build
```

## 使用

| 工具 | 说明 |
|------|------|
| `browser_console` | 读取浏览器端上报的日志（limit/level/sinceMs 过滤） |
| `browser_page` | 查看当前页面信息（URL/标题/客户端存活） |

## 技术要点

- client 插件通过 HMR 注入浏览器；host 侧无需轮询，纯事件上报
- 日志环形缓冲防内存膨胀；页面刷新后 client 重新 hook

## 相关

- [我的数字生命爱丽丝 — 插件生态中心（架构总览）](https://github.com/jonah791/alice-digital-life)

## License

MIT
