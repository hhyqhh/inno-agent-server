# 多用户与 Durable 重构

本文介绍 `inno-agent-server` 当前的多租户架构、与 legacy 运行时的边界，以及已经完成的验证。它描述的是**受控部署可用的多用户运行时**，不是公网账号安全、生产容量或自动故障转移的上线签字。

## 1. 重构目标

原版本地面向单个学习者：一个进程中的单例 `AgentSession`、共享 prompt queue 和 JSONL session 文件足以保证简单可靠，但不同会话不能真正并发，也无法把多个账号安全地放在同一服务中。

本次重构在不修改 PI SDK 内核的前提下加入两条路径：

- 保留 CLI、Desktop 和 local server 的 legacy 行为；
- 使用 `pi-durable` 为 Web 多用户服务提供独立会话并发、持久执行和崩溃恢复；
- 使用 Better Auth + PostgreSQL 提供账号、personal tenant 和资源所有权；
- 让模型配置、L1/L2/L3、OCR、频道、工作区和后台任务按 tenant 隔离；
- 为后续静态 sharded-worker 部署保留单 owner 存储边界。

## 2. 两种运行时

| 维度 | Legacy | Durable |
|---|---|---|
| 默认场景 | CLI、Desktop、local server | 多用户 Web 服务；local 可显式启用 |
| 会话存储 | PI JSONL | 每个 session 一个 SQLite 数据库 |
| 会话 ID | legacy session/`.jsonl` helper | `durable-<uuid>` |
| 并发 | 单例 AgentSession + 全局 prompt queue | 独立 session 并发，不经过 legacy 全局队列 |
| 崩溃恢复 | 文件历史保留，不提供相同的 submission 恢复 | 重新打开 storage、恢复未完成 submission、应用 SSE 精确回放 |
| 工具 | PI coding-agent 扩展；共享原生工具经反向适配器 | pi-durable 原生三参数 ABI |
| 多用户执行 | 禁止；历史资源只读 | 强制使用 |

local/authenticated compatibility mode 可通过 `INNO_DURABLE_ENABLED=true` 和 `POST /api/sessions` 的 `{ "runtime": "durable" }` 显式选择 Durable。`INNO_MULTI_USER_ENABLED=true` 时，省略 runtime 也只会创建 Durable；显式 legacy 执行返回 `409 durable_required`。已有 legacy 历史不会自动迁移或改写。

## 3. 请求与并发架构

```text
Browser / IM channel
        │
        ▼
Better Auth session 或独立 bearer-token ownership 校验
        │  服务端推导 identity；不信任 tenant/user/header 参数
        ▼
Personal tenant + PostgreSQL resource ownership
        │
        ├── 可选静态 tenant-owner 转发
        ▼
Tenant-scoped Durable catalog / workspace / config / memory
        │
        ├── Session A runtime ── Tenant A provider/model
        ├── Session B runtime ── Tenant B provider/model
        └── Session C runtime ── 独立 SQLite + SSE journal
```

不同 durable session 的模型请求可以重叠执行。每个 runtime 在打开时根据已验证 tenant 的配置构建隔离的 pi-ai `Models`，不会读取共享的 `models.json`/`auth.json`，也不会把另一个租户的凭证留在全局 registry 中。

主要模块位于 `apps/inno-agent/src/agent/`：

- `durable-runtime.ts`：pi-durable host、submission admission、恢复和 double-open guard；
- `durable-session-service.ts`：tenant catalog、idle lease 和 authenticated storage advisory lock；
- `durable-models.ts`：隔离的 provider/model runtime；
- `durable-stream-store.ts` / `durable-projection.ts`：历史投影与带连续 event ID 的 SSE journal；
- `durable-memory.ts`、`durable-ocr.ts`、`durable-channels.ts`：tenant-local 原生工具；
- `durable-questions.ts`、`durable-permissions.ts`：可恢复的问题卡和工作区写审批；
- `durable-job-runner.ts`：manual/cron/deferred agent job 的 Durable 执行。

## 4. 租户与安全边界

- 一个账号对应一个 personal tenant；当前没有 Organization/team 阶段。
- tenant 只能来自已验证的 Better Auth session、服务端 membership 或 PostgreSQL ownership。
- 未认证请求返回 401；跨 tenant 资源读取和执行返回 404。
- 新用户不继承全局 provider、OCR 或频道凭证；每个 tenant 使用自己的配置文件。
- 历史文件不会自动归属于第一个登录用户，必须运行显式 legacy-owner migration。
- authenticated 模式移除 PI host shell/通用 host file tools 和 PTY terminal；保留的路径工具执行 canonical workspace/symlink 检查。
- MCP、subagents、web-access、codemode、computer-use 等多用户尚未隔离的能力保持关闭，而不是伪装成 tenant-safe。

这些措施是应用层能力收缩，不等价于允许不可信租户执行任意宿主机代码的 OS sandbox。

## 5. 原生工具与记忆

共享 memory/OCR/channel 工具使用 pi-durable 原生执行签名：

```ts
execute(params, api, context)
```

稳定调用身份来自 `api.callId`，取消信号来自 `context.abortSignal`。Durable 不加载 legacy 五参数 adapter。legacy 入口仅通过 `legacy-tool-adapter.ts` 调用同一批原生定义，并补充 legacy 所需的 model/session context。

当前支持：

- L1 learner context、event/evidence、profile patch/update，带 session/tool-call operation markers；
- Durable L2 确定性 archive/query/lint，不在恢复路径嵌套模型摘要；
- tenant-owned legacy + committed durable history 的显式和自动 L3 recall；
- OCR job-ID checkpoint、轮询恢复和最终结果缓存；
- channel 文件 payload snapshot、原始目标固定、outbox completion cache；
- workspace `read`/`write`/精确替换 `edit`，以及可恢复的 write/edit approval；
- `ask_user_question`、BTW bring-back、结构化附件和 inline image/OCR fallback。

`replay: "safe"` 不代表外部世界天然 exactly-once。应用仍依赖 operation marker、checkpoint 或 outbox 处理重放。

## 6. 存储布局与单 owner 规则

```text
<dataDir>/tenants/<verifiedTenantId>/
├── config/config.json
├── durable/                 # catalog、session SQLite、question/permission records
├── learner/                 # L1 profile + events
├── l2/                      # wiki、manifest、index
├── l3/                      # tenant-owned history index
├── ocr/                     # OCR checkpoints
├── channels/                # dedupe、targets、outbox、run logs
├── jobs/                    # jobs、runs、occurrences
└── sessions/                # sidecars、SSE journals、activity
```

同一个 durable storage 同时只能有一个 owner。authenticated runtime 打开期间还持有 per-session PostgreSQL advisory lock，用于防止意外 double-open；它不是网络分区下的分布式 fencing。

可以使用静态 worker map 将 tenant 固定路由到拥有独立 RWO 数据卷的 worker：

```bash
INNO_DURABLE_SHARD_ID=worker-a
INNO_DURABLE_SHARD_URLS='{"worker-a":"http://worker-a:3000","worker-b":"http://worker-b:3000"}'
```

不得让多个进程 active-active 共用 SQLite/JSONL/NFS 数据根。当前没有自动 failover、动态服务发现或有序跨 owner 迁移。

## 7. 崩溃恢复与副作用语义

- `clientRequestId` 映射到 conversation-scoped durable request ID；已完成重试重新取得原 submission，不新增 user turn 或模型调用。
- 进程重启后重新打开 storage 并 `resume()`；应用 SSE journal 恢复已接纳 turn，并支持 `after=<eventId>` 连续回放。
- question/permission 的决定先持久化，再唤醒原 run；不会用 synthetic user message 恢复。
- L1 event/profile、OCR checkpoint 和 channel outbox 分别处理各自的 crash window。
- SQLite 使用 WAL + `synchronous=NORMAL`；宿主机/电源故障仍可能丢失最新提交。
- 模型调用、远端 OCR 首次提交、外部频道发送以及部分文件 mutation 仍存在 **at-least-once** 窗口，不能宣称计费或外部副作用 exactly-once。
- scheduler occurrence lease 只防止同一 slot 并发执行，不是 storage lock，也不是分布式事务。

完整实现约束见 [DURABLE_RUNTIME.md](./DURABLE_RUNTIME.md)。

## 8. 启动多用户服务

先准备 PostgreSQL、至少 32 字符的随机 secret 和本地配置文件，然后显式迁移：

```bash
export INNO_AUTH_MODE=better-auth
export INNO_MULTI_USER_ENABLED=true
export INNO_DURABLE_ENABLED=true
export DATABASE_URL=postgresql://inno:inno@127.0.0.1:5432/inno
export BETTER_AUTH_SECRET='replace-with-at-least-32-random-characters'
export BETTER_AUTH_URL=http://127.0.0.1:3000

npm run auth:migrate --workspace inno-agent
npm run build
npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

新账号先在 Settings 中配置自己的 provider/model，再创建会话。多用户模式下 Web UI 默认使用 Durable。

账号、迁移和公网限制见 [AUTHENTICATION.md](./AUTHENTICATION.md)。

## 9. 已执行验证

截至 2026-10-29，本分支已经完成：

- PostgreSQL-free suite：132 files / 981 tests；
- 真实临时 PostgreSQL integration：31 tests；
- `npm run build`：backend + frontend 通过；
- 独立真实服务验收：8 组通过，实际启动编译后的 `dist/server.js` 并驱动 HTTP/SSE：
  1. Better Auth 匿名 401 与 Durable probe；
  2. 跨 tenant detail/status/chat 404、legacy 409；
  3. 两用户 provider 请求真实重叠、credentials 隔离、request-ID 去重；
  4. 原生 L1/L2/L3/OCR/channel 工具及 tenant-local 文件；
  5. BTW bring-back 去重且无模型调用；
  6. workspace write 审批、stale/cross-tenant 拒绝与文件落盘；
  7. SIGKILL/restart 后 running turn 恢复、连续 SSE event ID、单 user turn；
  8. 独立 local legacy 会话经反向适配器执行 L1 工具。

真实服务验收使用本地 fake provider/OCR，没有调用付费模型。channel 只验证了受控的未配置响应，没有把该结果当作真实 IM 文件投递成功。

## 10. 尚未覆盖的生产事项

- 公网注册 rate limiting、邮箱验证、账号找回及完整账号安全评审；
- 真实模型、真实 IM 外部文件投递和生产凭证验证；
- K8s/Helm、RWO volume 运维、readiness/liveness、备份与回滚；
- 有序 owner shutdown、自动 failover、网络分区 fencing；
- 生产 HTTP/Pod 容量、成本与分片大小验证；
- Durable shell/delete/rename、branch editing、showcase export 等尚未支持的能力。

因此，当前结果证明的是已列出的功能和隔离边界，不是无条件的生产上线承诺。
