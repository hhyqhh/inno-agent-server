# 从真实对话导出一个可回放案例

本文档是「真实 Inno Agent 会话 → showcase 回放站」的完整操作手册。案例数据如何构成、脱敏规则、限制与排查都在后面几节。

## 总览

```
真实会话(runtime/data/sessions/*.jsonl + 工作区文件 + L1/L2 数据)
      │
      │  ① 产品内点按钮   或   ② CLI: npm run showcase:export -- --session <子串>
      ▼
案例目录 runtime/data/showcase-exports/cases/(index.json + <id>.json + assets/)
      │
      │  npm run showcase:view
      ▼
回放界面 http://localhost:4175(真实产品 UI + 流式回放)
```

导出的案例包含:

| 内容 | 来源 | 回放表现 |
|---|---|---|
| 消息流(含 thinking、工具调用、时间戳) | session JSONL | 逐字打字、工具卡片逐个出现 |
| 工作区文件(write/edit 写入) | 工具调用参数 | 精确重建,对应 tool_end 时刻出现 |
| 工作区文件(**bash 命令生成**:HTML/PDF/PPTX/下载物) | 导出时磁盘快照,按创建时间归属 | 在产出它的工具完成时出现 |
| 会话开始前已存在的文件 | 磁盘快照(mtime 早于会话) | 回放一开始就在目录树里 |
| L2 wiki 页面 | `l2_archive` 工具调用 | 笔记本文档列表逐个出现 |
| L1 学习者画像事件 + 画像快照 | `record_learning_event` + `profile.json` | 画像面板在首个事件后亮起 |

## 方式一:产品内一键导出(推荐)

### 一次性准备

按钮和接口需要新版本代码。如果你本机的 Inno Agent 服务是之前启动的,先重启加载新构建:

```bash
npm run build                  # 构建后端 + 前端
bash restart-dev.sh stop       # 停掉旧进程
npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

### 每次导出

1. 打开 Inno Agent 界面,左侧会话列表**悬停**要导出的那条会话;
2. 在动作栏点**场记板图标**「导出为回放案例」(在「导出为 Markdown」图标旁边);
3. 弹窗显示案例标题和导出目录(local 模式为 `runtime/data/showcase-exports/cases/`;Better Auth 模式为 `runtime/data/tenants/<tenantId>/showcase-exports/cases/`),点确定即可。
   多次导出自动合并到同一 tenant 的 index,不用管命名和覆盖。认证模式只读取当前 tenant 的 L1 画像。

标题默认取会话名(你改过名或自动生成过标题就用它),否则用首条用户消息。

### 查看回放

```bash
npm run showcase:view
```

首次会自动 `showcase:build`(约 6 秒),然后起本地服务 `http://localhost:4175` 并自动打开浏览器。首页同时列出**已发布案例**和你**自己导出的案例**,点进去就是完整流式回放(可调速、暂停、拖动进度)。

## 方式二:CLI 导出(适合批量 / 别的机器上的会话)

```bash
# 第 1 步:列出所有录制的会话(时间 / 工作区 / 回合数 / 首条用户消息)
npm run showcase:list

# 第 2 步:选中一条,用文件名任意子串导出
npm run showcase:export -- --session 15-55-58 \
  --title 高考数学立体几何题讲解 \
  --tags 互动提问,题目讲解 \
  --out runtime/data/showcase-exports/cases

# 第 3 步:看回放
npm run showcase:view
```

会话文件在 `runtime/data/sessions/*.jsonl`(其他部署:`<数据目录>/sessions/`)。`--session` 的子串匹配到多个会话时会报错并列出候选,加长子串即可。

### CLI 参数完整参考

| 参数 | 作用 | 默认值 |
|---|---|---|
| `--session <子串>` | 要导出的 session 文件名子串(必填) | — |
| `--out <dir>` | 案例输出目录 | `apps/showcase/public/cases`(**注意**:这是发布目录,本地自看请指到 `runtime/data/showcase-exports/cases`) |
| `--id <id>` | 案例 id(URL 路由用);仅限字母、数字、`.`、`_`、`-`,最长 128 字符,不能是 `index` 或路径 | `<日期>-<uuid前8位>` |
| `--title` / `--title-en` | 案例标题(中/英) | 首条用户消息前 40 字 |
| `--description` | 案例描述 | 空 |
| `--tags a,b` | 标签 | 空 |
| `--max-user-turns N` | 只保留前 N 个用户回合(截断长会话) | 不截断 |
| `--workspace-name` | 回放里工作区的显示名 | 工作区目录名 |
| `--exclude p1,p2` | 从文件快照排除的工作区相对路径 | 空 |
| `--sessions-dir <dir>` | session JSONL 所在目录 | `runtime/data/sessions` |
| `--data-dir <dir>` | 数据目录(画像快照来源) | `runtime/data` |
| `--only id1,id2` | 只导出 CASES 注册表里的指定案例 | 全部 |

`--only` 和 `--session` 都是**增量 upsert** index.json,不会冲掉同目录里已有的其他案例。

## showcase:view 详解

```bash
npm run showcase:view                      # 默认:overlay = runtime/data/showcase-exports/cases,端口 4175
npm run showcase:view -- --cases <dir>     # 换 overlay 目录(比如从别的机器拷贝来的案例包)
npm run showcase:view -- --port 4180       # 换端口
npm run showcase:view -- --build           # 强制重新构建 showcase 静态产物
npm run showcase:view -- --no-open         # 不自动开浏览器
```

工作原理:viewer 是一个零依赖静态服务器,把 `apps/showcase/dist`(已构建的回放站)和你的案例目录拼在一起——`/cases/*` 请求**优先**从 overlay 目录取, misses 回落到 dist 里打包的发布案例;`/cases/index.json` 是两者的合并(同 id 时 overlay 赢)。因此:

- 不需要把案例拷进 `apps/showcase/public/cases/`、也不需要重新 build 站点;
- 产品前端代码更新后,`npm run showcase:view -- --build` 重建一次即可让回放用上新 UI。

### 把案例搬到另一台机器

```bash
# 在导出的机器上:整个 cases 目录就是一个自包含案例包
tar czf my-cases.tgz -C runtime/data/showcase-exports cases
# 在目标机器上(需要有本仓库 checkout + 构建环境):
tar xzf my-cases.tgz
npm run showcase:view -- --cases ./cases
```

注意:案例包里的 bash 产物内容是导出那一刻的快照,跨机器搬运不影响已导出的内容;但**追加导出同一会话**必须回到原工作区所在的机器。

## 脱敏规则(导出时自动执行)

| 会处理 | 规则 |
|---|---|
| 本机绝对路径 | 会话工作区 → `/workspace`;其容器目录下的 `workspace-*` → `/workspace`;家目录 → `~`;`~/.inno-agent` 保留形式 |
| 其他用户路径 | `/Users/<名字>` → `~` |
| 当前用户名 | 单词边界匹配 → `learner` |
| 常见密钥形态 | `sk-…`/`pk-…`/`pat-…`/`tvly-…`/`ghp_…`/`gho_…`/`xox?-…`/`Bearer …`(要求前缀后有 `-`/`_`/空格分隔符)→ `[REDACTED]` |
| JSON 里的密钥字段 | `"apiKey"/"api_key"/"token"/"accessToken"/"refreshToken"/"secret": "…"` → `[REDACTED]` |
| 画像 `learner_id` | 固定改写为 `demo-learner` |

**不会处理**:消息正文本身(逐字保留)、密钥以外的个人化内容(你的提问、偏好、文件内容)。**导出后、分享前务必人工 review 生成的 JSON。**

## 内容截断上限(超出会被截断或跳过)

| 对象 | 上限 |
|---|---|
| thinking 单段 | 4,000 字符 |
| 工具参数 / 结果 | 1,200 / 2,000 字符 |
| write/edit 重建的文件内容 | 60,000 字符 |
| 内联文本文件(md/py/svg…) | 100 KB |
| 内联 HTML(回放预览需要内联 srcdoc) | 600 KB |
| 二进制资源(PDF/PPTX/图片,走 assets 目录) | 8 MB,超出跳过 |

## 注意事项与限制

1. **尽早导出**。bash 产物(生成的 HTML/PDF 等)取自**导出那一刻的磁盘现状**:会话结束后文件被改过,回放里就是新内容;文件被删,回放里就没有;工作区整个删掉,只剩消息流。
2. **共享工作区的归属**。多个会话共用同一个工作区时,bash 产物按「创建时间落在哪个会话窗口内」归属;归属到某会话后,再按创建时刻落在哪个工具调用的执行窗口内决定回放出现的时机。时间窗以会话**最后一条消息**为准(session JSONL 可能在会话结束后仍追加条目,不以此为准)。
3. **edit 未跟踪的文件**。会话里 edit 了一个不是本会话 write 的文件时,用磁盘现状做底,记录的编辑若已不适用则静默降级为「从首次 edit 起展示最终状态」。
4. **同名案例 id**。overlay 与发布案例同 id 时 overlay 赢(viewer 里看到的版本),不影响发布文件本身。
5. **大案例**。一个包含多个大 HTML/PDF 的案例可能达到几 MB(JSON + assets),回放加载一次后无性能问题,但发布前值得斟酌是否 `--exclude` 掉无关大文件。

## 发布正式案例(上线到回放站)

本地自看走上面的 overlay 即可;要让案例出现在**部署的 showcase 站点**上:

1. 在 `scripts/export-showcase-cases.ts` 的 `CASES` 数组里加一条注册(id、sessionFile、标题/描述/标签、可选 `maxUserTurns`/`excludePaths`);
2. `npm run showcase:export`(默认输出到 `apps/showcase/public/cases/`);
3. **人工 review JSON**(脱敏边界见上节);
4. 提交 `apps/showcase/public/cases/<id>.json` + `<id>/assets/` + `index.json`,重新部署站点。

## 故障排查

| 症状 | 原因与处理 |
|---|---|
| 侧栏没有场记板图标 / 点了报 404 | 服务器还是旧代码。`npm run build` 后重启服务 |
| `showcase:view` 报 cases dir 不存在 | 还没导出过。先按方式一/二导出一个 |
| viewer 页面 404 或样式全无 | `apps/showcase/dist` 未构建或过期:`npm run showcase:view -- --build` |
| 端口被占用 | `--port` 换端口;或 `lsof -nP -iTCP:4175 -sTCP:LISTEN` 找到旧进程杀掉 |
| 回放到一半目录树里看不到某个文件 | 树是折叠的——文件可能已出现但文件夹没展开;以「预览」页签里点开目录树为准,或等回放结束 |
| 回放突然不动 / 模块解析报错 | dev server 是 rebase 前启动的旧进程,杀掉重启(`pkill -f vite` 后重新 `showcase:dev` 或 `showcase:view --build`) |
| 导出的 HTML 回放里排版/脚本异常 | 若是内联 JS 被截断(见上限表)导致,属预期;否则提 issue 附案例 JSON |
| 导出后想改名/改标签 | 重新带 `--id <同id> --title …` 导出会 upsert 覆盖;或直接编辑 cases 目录里的 `<id>.json` 和 `index.json` |
