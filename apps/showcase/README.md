# Inno Agent Showcase

静态案例回放站：把真实使用 Inno Agent 的会话录制导出为 JSON，然后**直接用产品真实前端**流式回放——文字逐字打出、thinking 展开、工具调用逐个出现并完成、右侧文件预览/知识库（L2 wiki)/学习者画像（L1）实时联动，和真实使用完全一致。

## 工作原理（v3：真实 UI + 流式 mock 后端）

- **数据**：`scripts/export-showcase-cases.ts`（仓库根目录）从 `runtime/data/sessions/*.jsonl` 读取 PI 会话记录，复用后端 `parseSessionFile` 的聚合逻辑（user / assistant 回合合并 / toolResult 配对），脱敏本地路径、用户名与常见密钥形态后写入 `public/cases/<id>.json` + `index.json`。除聚合消息外还导出：
  - **流式段（stream segments)**:每条 assistant 消息保留原始 content block 顺序（thinking/text/toolCall）与时间戳，作为回放的事件脚本；
  - **面板关键帧**:workspace 文件（从 `write`/`edit` 工具调用重建，edit 未跟踪的文件用磁盘现状做底）、wiki 页面（`l2_archive`)、画像事件（`record_learning_event`)+ 脱敏 profile 快照，关键帧带 `toolCallId`，在对应 tool_end 流出的瞬间可见。
- **渲染**：不复制任何 UI——`App.tsx` 直接组合主应用（`inno-agent-web`）源码里的 `SessionSidebar` / `ChatCenter` / `WorkspacePanel` 真实组件（经 Vite alias `@inno-web` 指向 `apps/inno-agent/web/src`)，样式表整个复用。主应用前端更新后，重新 build 本站即同步。
- **流式 mock 后端**:`src/mock/runtime.ts` 在 `main.tsx` 最前面 shim 掉 `globalThis.fetch`。REST(`/api/sessions`、workspace tree/file、wiki、learner profile 等）按回放指针 + 已流出工具集合作答；**`POST /api/chat/stream` 返回 SSE 流**(`src/mock/streaming.ts`)，按流式段合成与真实后端完全相同的 `text_delta`/`thinking_delta`/`tool_call_delta`/`tool_start`/`tool_end`/`workspace_change`/`done` 协议，节奏来自录制时间戳（钳制）+ 逐块打字，`ask_user_question` 会弹出真实的提问对话框并自动回答。回放驱动只是逐个回合调用真实的 `chatStore.send()`——打字、工具卡片、"正在生成内容"文件预览、面板自动打开、wiki 自动刷新、done 后的 canonical 历史置换，全部是未修改的产品代码路径。
- **回放驱动**:`src/replay/driver.ts` 负责回合编排（真实时间间隔钳制 0.8s–4s)、播放/暂停（暂停 = SSE 生产器停在原地，像网络卡顿）、1×/2×/4× 倍速、拖拽/跳转（detach + canonical 前缀）、以及笔记本/画像 tab 的首次自动切换（预览面板由 store 的文件工具机制自己打开）。

## 常用命令（仓库根目录执行）

```bash
npm run showcase:export   # 重新导出案例(session → public/cases/*.json)
npm run showcase:dev      # 本地开发,Vite 在 :5174
npm run showcase:build    # 类型检查 + 构建静态产物到 apps/showcase/dist
```

## 新增一个案例

详细操作手册见 **[EXPORTING.md](./EXPORTING.md)**(导出内容、参数参考、脱敏规则、限制与排查)。三种方式速览:

**方式一:产品内一键导出(推荐)**——会话列表悬停某条会话 → 点场记板图标「导出为回放案例」,local 模式案例写入 `runtime/data/showcase-exports/cases/`;Better Auth 模式写入对应 tenant 的 `showcase-exports/cases/`。然后:

```bash
npm run showcase:view     # 起本地服务直接看回放,自动开浏览器(:4175)
```

**方式二:CLI 自助导出**:

```bash
npm run showcase:list        # 列出所有录制的 session
npm run showcase:export -- --session <文件名子串> --title 标题 --tags 标签1,标签2 \
  --out runtime/data/showcase-exports/cases
```

**方式三:发布正式案例**——在 `scripts/export-showcase-cases.ts` 的 `CASES` 数组注册,跑 `npm run showcase:export`(输出到 `public/cases/`),review 后提交。

**无论哪种方式,务必人工 review 生成的 JSON**(脱敏脚本处理路径/用户名/常见密钥形态,但消息正文是原文)。

## 部署

`vite build` 产物是纯静态文件（base 为相对路径），直接丢到 GitHub Pages / Vercel / 任意静态托管即可。路由用 hash(`#/case/<id>`)，不需要服务端 rewrite。

## 维护约束

- 主应用 `web/src/react/chat/` 下的组件必须保持纯 props 驱动，**不得 import store 或 api 层**——这是 showcase 能复用的前提。
- showcase 复用的是真实 store + 组件，因此主应用 store 的**公开方法签名**(`send` / `loadHistory` / `detach` / `openSession` 等）、**SSE 事件协议**(`ChatStreamEvent`,`web/src/types/chat.ts`）和 `/api/*` 的**响应结构**若发生 breaking change，需同步调整 driver / streaming.ts / mock 后端。
- 若 `ChatMessage` / `ChatToolRecord` 类型发生 breaking change，需同步调整导出脚本。
- **dev 模式的 optimizeDeps 陷阱**：pi-web-ui 只经 alias 在运行时触达，Vite dep 扫描发现不了它，必须 `optimizeDeps.include` 显式列出；又因为 mini-lit 被 exclude（打 marked 补丁用），它深引用的 `highlight.js/lib/core` 等 9 个子路径也必须逐个 include，否则 dev 下 CJS 裸导入直接白屏崩溃（生产 build 不受影响）。详见 `vite.config.ts` 注释。
- **headless 验证注意**：默认 800×600 视口会触发真实 App 的窄屏媒体查询把右侧面板强制收起，验证面板联动必须 `--window-size=1440,900`;`--virtual-time-budget` 会冻结 WAAPI/motion 动画（气泡停在 opacity:0)，截图里消息"消失"是伪影，要看 DOM；同一 Chromium 二进制的多次 headless 运行共享 profile,localStorage 会恢复上次案例，验证特定案例务必带 `#/case/<id>`。

