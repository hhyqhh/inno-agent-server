# Inno Agent Server

> **[Inno Agent](https://github.com/hhyqhh/inno-agent) 的多用户服务端版本。** 在原项目能力之上，加入 Better Auth + PostgreSQL personal tenant、独立 Durable 会话并发、崩溃恢复、租户级状态和可选静态 worker 路由。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg)](https://nodejs.org)
[![Release](https://img.shields.io/github/v/release/hhyqhh/inno-agent-server.svg)](https://github.com/hhyqhh/inno-agent-server/releases)

[English](./README.md) | **简体中文**

原项目的个人学习目标、分层记忆设计、桌面应用、技术报告和截图，请访问 **[Inno Agent 原项目](https://github.com/hhyqhh/inno-agent)**。本仓库聚焦服务端运行时，不再重复这些背景介绍。

多用户架构、真实服务验收结果和生产边界见[多用户 Durable 指南](./docs/MULTI_USER_DURABLE.md)。

## 运行时边界

当前有两条显式执行路径：

- **Legacy 兼容路径**——CLI、Desktop 和 local server 默认保留单例 `AgentSession`、JSONL 历史、宿主工具和串行 prompt queue，仍是最简单的个人运行方式。
- **Durable 执行路径**——`INNO_DURABLE_ENABLED=true` 启用独立的 per-session SQLite runtime；多用户模式强制使用 Durable，不回退到 legacy 全局队列。支持独立会话并发、request-ID 去重、崩溃恢复、连续 SSE 回放、可恢复的问题卡/审批，以及 tenant-local memory/OCR/channel。
- **经验证的租户隔离**——Better Auth + PostgreSQL 提供 personal tenant 和资源所有权。provider 凭证、记忆、工作区、频道和任务均使用 tenant 数据根；未认证返回 401，跨租户资源返回 404。authenticated 模式关闭宿主 shell/通用文件工具和 PTY。
- **单 owner 存储**——一个 durable storage 同时只有一个 owner。静态 tenant-owner 路由要求每个 worker 使用独立 RWO 数据根；不支持共享 SQLite/NFS active-active、自动 failover 或网络分区 fencing。
- **明确的恢复语义**——已提交状态和应用 checkpoint 可以恢复，但模型调用、首次远端 OCR 提交、频道投递和部分文件 mutation 仍有 at-least-once crash window。

架构、验证范围和剩余生产事项见[多用户 Durable 指南](./docs/MULTI_USER_DURABLE.md)与 [Durable 运行时契约](./docs/DURABLE_RUNTIME.md)。

## 功能特性

- 👥 **多用户 Durable 服务**——Better Auth + PostgreSQL personal tenant、独立会话并发、租户级凭证与存储、崩溃恢复、SSE 回放和可选静态 worker 路由。

- 🧠 **三层记忆**
  - **L1 学习者画像**——目标、知识状态、误解、偏好;每轮汇总为上下文包注入系统提示词。
  - **L2 原生 wiki**——人类可读、agent 可查询的页面,混合检索(词法 BM25 + 知识图谱),LLM 辅助摘要,支持 PDF/Office/图片摄入。
  - **L3 会话检索**——会话历史索引进 SQLite(FTS5),按相关性阈值门控的跨对话召回。
- ⏰ **主动调度器**——自然语言创建 cron 任务,可从 agent、UI 或守护进程触发。
- 💬 **个人 IM 渠道**——飞书(原生)+ 微信(iLink 扫码登录或 bridge 模式),统一dispatcher 回推提醒。
- 🧪 **练习实验室**——工作区级 Web 终端(xterm.js over WebSocket),运行记录可被 agent 读取。
- 🎯 **简单模式 + 预设**——面向非技术用户的一键预设工作区(教案、PPT 制作、情景讲解)。
- 🧩 **技能系统 + 内容中心**——从远程 hub(GitHub 仓库或自建 bundle 服务)浏览、导入技能与预设。
- ✏️ **对话分支编辑**——重新编辑已发送的纯文本 Web 消息，并从该节点重新生成后续对话；旧分支不会进入当前模型上下文。
- 🔌 **可插拔模型供应商**——任意 `openai-completions` 或 `anthropic-messages` 端点(Anthropic、OpenAI、DeepSeek、Ollama、本地模型),UI 内实时切换。
- 🌍 **国际化与主题**——中/英文界面,四套主题。
- 🛡️ **可选系统级沙箱**——通过 [pi-sandbox](https://github.com/carderne/pi-sandbox) 管控 bash/文件操作;可选 `pi-subagents` 子代理。
- 🖥️ **电脑控制(桌面端)**——桌面应用可通过 [`pi-computer-use`](https://github.com/injaneity/pi-computer-use) 查看并操作本机屏幕(无障碍树优先);服务器部署默认关闭。见[电脑控制](#电脑控制-computer-use)。

## 快速开始

### 方式 A —— 源码运行

```bash
git clone https://github.com/hhyqhh/inno-agent-server.git
cd inno-agent-server

npm install      # 从 npm 拉取 Pi SDK
npm run build    # 编译后端 + 前端

mkdir -p runtime/config runtime/data runtime/skills workspace
cp config.example.json runtime/config/config.json
# 编辑 runtime/config/config.json,填入 providers[*].apiKey

npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

打开 **http://localhost:3000**。详细的 5 分钟上手指南(含各供应商配置示例)见 **[QUICKSTART.md](./QUICKSTART.md)**。

### 方式 B —— Docker

```bash
docker compose up -d   # 服务端口 3000,挂载 runtime/ 与 workspace/
```

## 运行模式

```bash
npm run server          # Web UI(API + 已构建前端,端口 3000)
npm run start           # CLI(纯终端 agent,无 HTTP)
npm run electron        # 本地运行桌面应用
npm run server:sandbox  # 带系统级沙箱的 Web UI(需要 ripgrep)

# 开发模式:后端 :3000 + Vite 热更新 :5173
npm run dev:server & npm run web:dev
```

`restart-dev.sh` 编排完整开发生命周期(构建、启动、停止、状态、日志、冒烟测试)——运行 `bash restart-dev.sh --help` 查看。

### 多用户 Durable 服务

```bash
export INNO_AUTH_MODE=better-auth
export INNO_MULTI_USER_ENABLED=true
export INNO_DURABLE_ENABLED=true
export DATABASE_URL=postgresql://inno:inno@127.0.0.1:5432/inno
export BETTER_AUTH_SECRET='replace-with-at-least-32-random-characters'
export BETTER_AUTH_URL=http://127.0.0.1:3000

npm run auth:migrate --workspace inno-agent
npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

每个账号在 Settings 中配置自己的 provider/model。该模式面向受控部署，不代表公网账号安全或生产容量已经验收。完整边界见[认证与租户隔离](./docs/AUTHENTICATION.md)和[多用户 Durable 指南](./docs/MULTI_USER_DURABLE.md)。

## 配置

`runtime/config/config.json`(模板:[`config.example.json`](./config.example.json)):

```json
{
  "defaultProvider": "innospark",
  "defaultModel": "claude-sonnet-4-6",
  "providers": {
    "innospark": {
      "baseUrl": "https://api.example.com",
      "api": "anthropic-messages",
      "apiKey": "replace-me",
      "models": [{ "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" }]
    }
  },
  "server": { "port": 3000 },
  "channels": {
    "feishu": { "enabled": false },
    "wechat": { "enabled": false, "mode": "ilink" }
  },
  "memory": { "l1Enabled": true, "l2Enabled": true, "l3Enabled": true },
  "ui": { "theme": "light", "closeBehavior": "ask" }
}
```

每个供应商声明 `baseUrl`、`api`(`openai-completions` 或 `anthropic-messages`)、`apiKey` 和 `models[]` 列表。在 UI 中切换模型时,服务器会热更新此文件。

### 运行时路径

CLI 与 server 都通过 `apps/inno-agent/src/runtime.ts` 解析路径。优先级:**CLI 参数 > 环境变量 > `~/.inno-agent/...`**。

| CLI 参数 | 环境变量 | 默认值 |
|---|---|---|
| `--home` | `INNO_HOME` | `~/.inno-agent` |
| `--config-dir` | `INNO_CONFIG_DIR` | `<home>/config` |
| `--data` | `INNO_DATA_DIR` | `<home>/data` |
| `--skills` | `INNO_SKILLS_DIR` | `<home>/skills` |
| `--workspace` | `INNO_WORKSPACE_DIR` | 调用时的工作目录 |
| `--port` | `INNO_PORT` | `3000` |

### 电脑控制(Computer Use)

桌面应用内置 GUI 电脑控制能力(基于 [`@injaneity/pi-computer-use`](https://github.com/injaneity/pi-computer-use)):agent 通过操作系统无障碍树观察窗口,并可执行点击、输入、滚动、浏览器操控。被动观察类工具始终放行;每个有副作用的动作(`act_ui`、浏览器启动/导航/页面内 JS)都会先弹出审批卡片。macOS 首次使用会安装已签名的 helper 到 `~/Applications/pi-computer-use.app`,需在 **系统设置 → 隐私与安全性** 中授予**辅助功能**与**屏幕录制**权限(授权后若未生效,执行 `pkill -f pi-computer-use.app` 重启 helper)。

**开启 / 关闭:**

- **桌面应用**——默认开启。在 **设置 → 通用 → 电脑控制** 中切换,然后重启应用(工具在会话启动时注册,更改在重启后生效)。
- **本地服务器 / CLI**——默认关闭。带上桌面标记启动即可开启:

  ```bash
  INNO_DESKTOP=1 npm run server -- --home ./runtime --workspace ./workspace --port 3000
  ```

  要关闭,**不带 `INNO_DESKTOP` 重启服务**即可。
- **显式覆盖**(优先级高于环境变量默认值,双向生效),在 `config.json` 中:

  ```json
  "plugins": { "computerUse": { "enabled": true } }
  ```

- **线上部署**——保持默认(不设置 `INNO_DESKTOP`)即为关闭。

### 内容中心(Content Hub)

技能库与简单模式预设均从远程**内容中心**拉取——默认是公开 GitHub 仓库 [`Chloris-Blaxk/inno-agent-hub`](https://github.com/Chloris-Blaxk/inno-agent-hub)。在 `config.json` 的 `contentHub`(或 **设置 → 内容中心**)中可切换为私有 GitHub 仓库(`"type": "github"`)或自建 bundle 服务(`"type": "bundle"`)——零依赖的 bundle 服务器见 [`scripts/content-hub-server/`](./scripts/content-hub-server/)。预设下载后本地缓存,应用内置模板作为离线兜底。

## 架构

四层结构：**用户界面 → 认证与租户应用层 → legacy 或 Durable agent 运行时 → 分层记忆。**

```text
用户界面          CLI · Web UI (React) · 桌面应用 · 飞书 · 微信
        ↓
应用层            Better Auth · personal tenant · ownership · HTTP/SSE
                  渠道 · 调度器 · 工作区 · Practice Lab (local)
        ↓
Agent 运行时      Legacy PI AgentSession ──或── pi-durable session runtimes
(PI SDK,未修改)   共享原生工具；legacy 独立反向适配器
        ↓
分层记忆          L1 学习者画像 · L2 原生 wiki · L3 会话检索
                  local 使用全局目录；多用户使用经验证的 tenant 数据根
```

- **Agent 核心**——legacy 使用 `@earendil-works/pi-coding-agent` 与 [`inno-extension.ts`](./apps/inno-agent/src/agent/inno-extension.ts)；Durable 使用独立的 `pi-durable` runtime，不经过 legacy 全局 prompt queue。memory/OCR/channel 工具使用原生 `(params, api, context)` ABI，legacy 仅通过独立反向适配器复用。PI SDK 内核不被修改。
- **多用户与恢复**——Better Auth + PostgreSQL 验证身份和所有权。Durable 提供 per-session SQLite、request-ID 去重、应用 SSE journal、问题/审批恢复和独立会话并发。详见[多用户 Durable 指南](./docs/MULTI_USER_DURABLE.md)。
- **记忆**——L1(`src/memory/learner/`):证据驱动的画像 + 事件日志。L2(`src/memory/l2/`):带图谱、摘要、文档摄入与混合检索的结构化 wiki,经 agent 工具和 `/api/wiki/*` 暴露。L3(`src/memory/l3/`):tenant-scoped SQLite FTS5 索引,覆盖 owned legacy JSONL 与已提交的 Durable 历史。
- **调度器**(`src/scheduler/`)——cron 任务持久化到 `jobs.json` + `runs.jsonl`。
- **渠道**(`src/channels/`)——`ChannelRegistry`,支持飞书、微信(iLink / bridge)、QQ(bridge)。
- **HTTP 服务**(`src/server.ts`)——原生 Node `http.createServer`,SSE 流式对话 + WebSocket 终端;路由表见 [`apps/inno-agent/README.md`](./apps/inno-agent/README.md)。
- **Web UI**(`web/src/`)——React 19 + Tailwind 4。状态在框架无关的 `EventEmitter` stores(`web/src/stores/`),REST/SSE 调用在 `web/src/api/`。

## 仓库结构

```text
apps/inno-agent/           后端(CLI + HTTP 服务),TypeScript → dist/
apps/inno-agent/web/       前端(React 19 + Tailwind 4 + Vite)
apps/inno-agent/presets/   内置预设工作区(离线兜底)
electron/                  Electron 主进程(桌面应用)
scripts/content-hub-server/  自建内容中心 bundle 服务
runtime/                   本地运行时状态(配置、数据、技能)—— gitignored
workspace/                 默认 agent 工作目录 —— gitignored
```

## 部署

典型的生产布局,分离代码、配置、数据与工作区:

```bash
INNO_CONFIG_DIR=/etc/inno-agent \
INNO_DATA_DIR=/var/lib/inno-agent/data \
INNO_SKILLS_DIR=/var/lib/inno-agent/skills \
INNO_WORKSPACE_DIR=/srv/inno-workspace \
INNO_PORT=3000 \
npm run server
```

提供 [`Dockerfile`](./Dockerfile) 与 [`docker-compose.yml`](./docker-compose.yml) 作为起点；完整依赖说明见 [`docs/SYSTEM_DEPENDENCIES.md`](./docs/SYSTEM_DEPENDENCIES.md)。Better Auth + PostgreSQL、租户隔离和公网账号限制见 [`docs/AUTHENTICATION.md`](./docs/AUTHENTICATION.md)；Durable 架构、静态 worker 路由、验收结果和单 owner 部署边界见 [`docs/MULTI_USER_DURABLE.md`](./docs/MULTI_USER_DURABLE.md)。桌面打包说明见 [`ELECTRON_BUILD.md`](./ELECTRON_BUILD.md)。

## 使用案例与文档

- [多用户 Durable 架构与验收](./docs/MULTI_USER_DURABLE.md)——重构目标、租户边界、恢复语义、真实服务验收和生产缺口。
- [Durable 运行时契约](./docs/DURABLE_RUNTIME.md)——存储、重放、工具、调度和频道实现细节。
- [认证与租户隔离](./docs/AUTHENTICATION.md)——Better Auth 配置、显式 legacy-owner 迁移和账号安全边界。
- [技能教程 —— 构建工作区 Agent](./docs/use-cases/skill-tutorial.md)——用 `agent.md` 和 `.skills/` 构建工作区范围的自定义学习 agent。
- [QUICKSTART.md](./QUICKSTART.md)——5 分钟上手指南。
- [apps/inno-agent/README.md](./apps/inno-agent/README.md)——后端 API 路由表。

## 贡献

欢迎 Issue 和 PR。提交 PR 前请运行 `npm test` 与 `npm run build`；涉及认证、租户所有权或 Durable 恢复的改动，还应使用真实 PostgreSQL 运行 `npm run test:integration`。保持改动聚焦，遵循现有代码风格，行为变更时同步更新文档。

## 社区

扫码加入微信用户群,提问、分享使用场景、关注更新:

<p align="center">
  <img src="./docs/assets/wechat-community-qr-2026-10-24.jpg" alt="Inno Agent 微信社区群二维码" width="240" />
</p>

## 许可证

[MIT](./LICENSE)。本项目依赖 Pi SDK(`@earendil-works/pi-*`,作者 Mario Zechner),同为 MIT 许可,经 npm 引入。

## 引用

```bibtex
@misc{hao2026innoagent,
  author       = {Hao Hao, Ye Lu, Ruotong Yang, Yongheng Guo and Aimin Zhou},
  title        = {Inno Agent: An Open-Source Personal Learning Agent with Layered Memory, Educational Post-Training, and Local Deployment},
  year         = {2026},
  publisher    = {GitHub},
  journal      = {GitHub repository},
  howpublished = {\url{https://github.com/hhyqhh/inno-agent-server}}
}
```
