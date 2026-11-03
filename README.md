# dsh-notion

**Four consolidated Notion tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — built on Notion's official `ntn` CLI instead of the official Notion MCP server.

简体中文 | [English](#english)

---

## 为什么是 4 个工具，而不是 67 个

Notion 官方 MCP 暴露**数十个**工具（数量随版本变动，60+），其中大量能力重叠、命名分散。工具越多，模型每轮吃的 schema 越多、选错工具的概率越高，实际干活反而更慢。

dsh-notion 的做法是**收敛工具面**：

- 只保留日常使用频率最高的四件事：**找 → 读 → 写一个页面 → 查一张表**
- 一个工具覆盖一组相关动作（例如 `notion_page` 用 `action` 区分 create/edit/attach/trash），而不是每个动作一个工具
- 基于官方 `ntn` CLI，直连稳定能力，不额外维护一套 API 客户端
- 结构化 JSON 返回，只给模型稳定、精简的字段，不把原始 Notion 对象塞进上下文
- 写操作有安全网：库页属性按 schema 校验、create 失败自动回滚、attach 拒绝成环和覆盖
- 后续只补充**确实必要**的能力（评论、文件上传等），不为了"全"而堆工具

## 四个工具

| Tool | 作用 | 典型场景 |
| --- | --- | --- |
| `notion_search` | 按标题搜索工作区（page / database） | 用户说"找一下某页"，还没有 id |
| `notion_get` | 读页面 Markdown，或读数据库/data source 的 schema | 读正文、看有哪些列可写 |
| `notion_page` | create / edit / attach / trash | 新建页、改正文、改列、挂父级、删页 |
| `notion_query` | 对已知数据库/data source 做 filter / sort / 分页 | "这个库里未完成的任务有哪些" |

> `search` 找对象，`query` 查表里的行；两者职责不混。

## 安装

### 1. 安装官方 Notion CLI

```bash
# macOS (Homebrew)
brew install --cask notion-cli

# 或 npm
npm i -g ntn

ntn --version
```

登录方式二选一：`ntn login`，或设置 `NOTION_API_TOKEN`（见下）。

### 2. 安装插件到 DeepSeek Harness

把仓库放到固定目录后，让 DSH 安装（需要 profile 可写）：

```
plugin_manager install_bundle  target=/absolute/path/to/dsh-notion
```

也可以直接用 git 地址安装。装好后插件行 id 是 `notion-tools`，四个工具出现在工具列表里。

### 3. 配置 token

token 不写进插件代码，按优先级读取：

1. 环境变量 `NOTION_API_TOKEN`
2. 插件目录内的 `notion-token` 文件（首个非注释行）
3. `ntn login` 保存的登录态

```bash
export NOTION_API_TOKEN=secret_xxx
# 或
echo 'secret_xxx' > <插件目录>/notion-token
```

Integration 需要在 Notion 里 Share 给目标页面/数据库，否则 API 返回 404。

### 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `tokenFile` | `notion-token` | token 文件；相对路径按插件目录解析 |
| `workspaceId` | 空 | 多 workspace token 时指定（`NOTION_WORKSPACE_ID`） |
| `ntnPath` | 自动发现 | `ntn` 可执行文件路径，自动兜底 `/opt/homebrew/bin`、`/usr/local/bin`、PATH |
| `timeoutMs` | `60000` | 单次 `ntn` 调用超时（毫秒） |

## 参数速查

### notion_search

```jsonc
{ "query": "项目计划", "limit": 10, "filter_object": "page" }
```

### notion_get

```jsonc
{ "id_or_url": "https://www.notion.so/<id>", "format": "md" }   // 读页面
{ "id_or_url": "<database-id>" }                                // 读 schema
```

### notion_page

```jsonc
// 新建普通子页（正文放 props.body_content，或用顶层别名 content）
{ "action": "create", "parent": "page:<page-id>", "title": "标题",
  "props": { "body_content": "# 标题\n\n正文" } }
{ "action": "create", "parent": "page:<page-id>", "title": "标题",
  "content": "# 标题\n\n正文" }          // 等价写法

// 新建数据库行（可同时写列）
{ "action": "create", "parent": "data-source:<ds-id>", "title": "任务 A",
  "props": { "body_content": "说明", "Status": "进行中", "标签": ["验收"],
             "截止日期": "2026-01-31", "Done": false } }

// 设图标：emoji、外链图片，或 null 清除
{ "action": "create", "parent": "page:<page-id>", "title": "标题",
  "props": { "body_content": "# 标题\n\n正文", "icon": "🎯" } }
{ "action": "edit", "id": "<page-id>", "props": { "icon": "https://example.com/logo.png" } }
{ "action": "edit", "id": "<page-id>", "props": { "icon": null } }

// 改正文 / 改列 / 两者都改
{ "action": "edit", "id": "<page-id>", "props": { "body_content": "# 新正文", "Status": "Done" } }

// 挂到父页 / 父行（不传 props，不是文件上传）
{ "action": "attach", "id": "<page-id>", "parent": "page:<parent-id>" }

// 删除（必须 yes:true）
{ "action": "trash", "id": "<page-id>", "yes": true }
```

`props` 是**属性名 → 值**的对象 map，按列类型自动转换（title/rich_text、number、select/status、multi_select、date、checkbox、url/email/phone、people/relation）。失败时分两种：**未知列名 / 只读列 / 保留键冲突**会返回可写列清单（写进消息文本）；**值类型不符**只指出属性名与期望类型，不列清单。非列名的保留键有两个：

| 保留键 | 含义 | 取值 |
| --- | --- | --- |
| `props.body_content` | 页面正文 Markdown（顶层 `content` 是它的别名） | 字符串 |
| `props.icon` | 页面图标 | 单个 emoji（`"🎯"`）、`http(s)` 图片 URL、已构好的 Notion icon 对象（`{"type":"emoji","emoji":"🎯"}`）、或 `null` 清除 |

保留键不会被当成列写入；如果数据源里**真的有**同名列，写入会直接报错而不是猜你的意图。绝不静默写错列。

### notion_query

```jsonc
{
  "database_or_data_source": "<ds-id 或 url>",
  "limit": 25,
  "filter": { "property": "Status", "status": { "equals": "进行中" } },
  "sort": "截止日期 asc",
  "under": "<父行 id>"        // 只查某个父行下的子行（走 Parent-item 关系列）
}
```

## ⚠️ edit 的正文是「整页替换」

`notion_page action="edit"` 里传 `props.body_content`（或别名 `content`）时，底层是
`ntn pages edit --content`，而 CLI 自己的帮助写的很清楚：

```
--content <MARKDOWN>    Markdown content to replace the page with
```

**`replace` —— 整页正文被替换，不是追加，不是局部修改。** 你这次没写进去的内容会消失，
而 Notion 不会为正文保留版本历史，回收站也救不回来。

```jsonc
// ❌ 想改中间一段，只发这一段 → 其余全部被删
{ "action": "edit", "id": "<id>", "props": { "body_content": "## 只改第二段

新内容" } }

// ✅ 改正文 = 重发完整正文
{ "action": "edit", "id": "<id>", "props": { "body_content": "<完整的、改好的整篇正文>" } }

// ✅ 只改标题/列/图标 → 根本不要传 body_content
{ "action": "edit", "id": "<id>", "props": { "icon": "🎯", "Status": "完成" } }
```

### 长度突变保护

`edit` 在覆盖前会先统计现有正文的字数，并把结果**写进返回值**：

```
已更新页面 <id> 的内容
正文已整页替换：12000 字 → 340 字
```

若新正文 **不足原来的一半**（且原文 ≥ 200 字），工具会**直接拒绝**：

```
[INVALID_INPUT] edit 的 body_content 会【整页替换】现有正文，不是追加、不是局部修改。
这次替换会让正文从约 12000 字变成 340 字（减少 97%）。确认要整页覆盖请加
confirm_shrink: true；只想改一小段的话，请重发完整正文内容。
```

确属整页重写时加 `confirm_shrink: true` 放行：

```jsonc
{ "action": "edit", "id": "<id>", "props": { "body_content": "<新的整篇正文>" },
  "confirm_shrink": true }
```

返回值里始终带 `body_chars_before` / `body_chars_after`，可以据此核对是否真的只有预期变化。
读不到原文时（网络/权限问题）保护会退化为「长度未知」并放行——**不会因为读不到就卡住你**。

**长文档推荐的写法**：一次性 `create` 写完整篇，之后不要再 `edit` 正文；真要改，
要么重发全文、要么新建一页再 `trash` 旧的。

## 删除（trash）的三重保护

`notion_page action="trash"` 不是对 `ntn pages trash` 的薄包装，它在调用前先判定目标类型：

| 情况 | 行为 |
| --- | --- |
| 目标是 **database / data source** | **直接拒绝**，即使 `yes: true`。删除数据库会连带它的数据源和全部行，破坏性远超删页面，所以交给用户手动确认。 |
| 目标**已在回收站/已归档** | 返回**成功**（`already_archived: true`，且 `changed: []`），不报错。`ntn` 对已归档对象会返回 `400 Can't edit block that is archived`，那看起来像故障并诱导重试，而删除本来就应当幂等。**注意：什么都没写，所以 `changed` 为空**，不要把 `changed` 非空当成已执行删除。 |
| 目标页面**有子页面** | **默认拒绝**，返回子页面 id 列表，提示需要 `recursive: true`。Notion 归档父页面会连带归档整棵子树，调用方必须先看到还会删掉什么。 |
| 目标页面**无子页面** | 正常删除。 |

```jsonc
// 有子页面时，需要显式同意连带删除
{ "action": "trash", "id": "<page-id>", "yes": true, "recursive": true }
```

`yes` 与 `recursive` 是两件事：`yes` 表示「我确认要删除」，`recursive` 表示「我确认连同子页面一起删除」。只有 `recursive` 而没有 `yes` 仍然会被拒绝。

子页面检查走 `GET v1/blocks/{id}/children`，会顺着 `next_cursor` **翻到最后一页**再判断。不能只翻一页：该接口是按**块**分页的（默认每页 100 个块），一个大页面里大量段落会把子页面挤到后面的页，漏读就会漏报子页面、进而误判可以删除。翻页上限只作为失控保护（10000 块），真到达上限时**拒绝删除**而不是猜。

## 包容输入

模型不需要记住精确拼写。插件在参数层做**同义词与类型宽容**，只有无法对应到任何明确意图的输入才报错。

**同义词**（`action` 字段）：

| 说成 | 归一为 |
| --- | --- |
| `delete` / `remove` / `archive` / `destroy` | `trash` |
| `update` / `modify` / `change` / `set` / `patch` | `edit` |
| `move` / `reparent` / `link` | `attach` |
| `new` / `add` / `make` / `insert` | `create` |

大小写、连字符、下划线、空格都不敏感（`"Delete"`、`"re-parent"` 都可以）。

**类型宽容**：`yes` 接受 `true` / `"true"` / `"yes"` / `1` / `"1"`；`limit` 接受数字字符串，小数会被截断（`2.5` → `2`，但 `<= 0` 仍报错）；`id` 接受 UUID、32 位 hex 或**整条 Notion URL**。

**不做的事**：拼写错误不做模糊匹配（`trsh` 不会被猜成 `trash`）。猜错可能执行成另一个真实存在的写操作，风险大于收益。

**id 类型基本不用记**：`notion_get` 按 page → database → data source 三级回退，`notion_query` 对 database id 自动 resolve，所以 `notion_search` 返回的 id 可以直接给这两个工具。但 `notion_page` 只接受**页面** id（或数据库行 id）：拿 database/data source id 去 edit 会失败，要把容器写成 `database:<id>` / `data-source:<id>` 传给 `parent`。

## 设计取舍

- **更少、更稳的 schema**：四个工具的参数都是小对象，减少模型在工具选择上的犹豫和 token 开销。
- **一个工具一组动作**：`action` 分支比十几个单动作工具更容易被模型正确使用。
- **写入可回滚**：`create` 是两步写（建页 + 属性 PATCH），第二步失败会自动把新页 trash 掉，并报告 `partial` / `rollback`。
- **关系安全**：`attach` 行→行会做 Parent-item 环检测；覆盖已有父级必须显式 `yes:true`。
- **不猜列**：`notion_get` 标出可写列和 Parent-item 候选列，`notion_page` / `notion_query under` 直接复用同一套选择逻辑。
- **图标是页面字段，不是列**：Notion CLI 的 `pages create/edit` 没有 `--icon`，插件把 `props.icon` 归一化后并入同一次属性 PATCH（只有 icon 时发 icon-only 请求），create 时图标也参与回滚判定。

## DSH 集成方式

每个工具都是一个原生 DSH `ToolDefinition`，直接 `ctx.tools.register`：

```ts
{
  name, description, parameters,      // 模型可见：名称 + 描述 + JSON Schema（DSH 强制子集）
  output: { schema, render },         // 返回值的规范 JSON 契约 + 渲染成文本块
  execute(args, exec)                 // 工具体：返回规范值，抛错即失败结果
}
```

因此模型的全部认知只来自 **description + 参数描述**——**单个工具定义**没有独立的 prompt/guideline 字段（pi 的 `promptSnippet`/`promptGuidelines` 在这套接口里不存在）。DSH 另有 `ctx.systemPrompt.section()` 可以在系统提示里加段落，本插件故意不用：4 个工具的规则放在各自的 description 里更贴近使用现场。插件把使用规则（保留键、必填项、回滚语义、分页方式）写在这两处，而不是散落在别处。

`execute` 返回的是领域值（如 `{ ok, action, id, url, parent, properties, changed }`），文本由 `output.render` 派生，因此同一个定义在原生 function calling 和 PTC（`run_code`）两种呈现方式下都成立。

**注意 `details` 不会到模型**：DSH 只把抛出的 `message` 渲染成 `Error: <message>`，错误对象上的 `.details`（含 `hint_properties`）仅用于测试和日志。所以可写列清单是被**写进消息文本**的，不是靠 `details` 传递。

### 错误码

DSH 把抛出的错误渲染成 `Error: <message>`，只对它自己的 `HarnessError` 保留结构化 `{ name, code }`；普通 Error 的 `code` 会被丢弃。所以本插件把错误类别写进消息开头，确保模型与日志都能看到：

| 前缀 | 含义 | 模型该怎么做 |
| --- | --- | --- |
| `[INVALID_INPUT]` | 参数不可用（未知列名、只读列、保留键冲突、id 非法…） | 读消息里的可写列清单，改参数重试 |
| `[NTN_FAILED]` | `ntn` 本身失败（未登录、无效 token、Notion API 报错、exit ≠ 0） | 检查 token / workspace / 权限，或原样上报 |
| `[ABORTED]` | 调用**被取消**（子进程已被 SIGTERM）。注意：DSH 层超时不走这个码——`dsh-tool-call-timeout-policy` 会报 `TOOL_TIMEOUT`；`ntn` 自己的进程超时归入 `[NTN_FAILED]` | 通常无需重试，或换更小的查询 |
| `[PARTIAL_WRITE]` | 后续写入失败且回滚也失败，工作区留下了半成品 | 用消息中给出的 id 手动 `trash` 或 `edit` 清理 |

成功回滚的 create 不报 `[PARTIAL_WRITE]`，而是保留真正失败的那个类别（`[NTN_FAILED]` / `[INVALID_INPUT]`），并附带 `partial: false`。

## 后续

- 评论读写
- 文件上传（`notion_file`，与 attach 无关）
- 页面 cover（icon 已支持：`props.icon`）
- 更完整的 people / mention 解析

## 开发

```bash
npm install
npm run build        # 打包 dist/index.js（esbuild）
npm test             # 单元测试（mock，不需要 token、不联网）
npm run typecheck    # tsc --noEmit
```

插件源码结构：

```
src/dsh/      # DSH Host 层：tool.ts 工具契约、index.ts 注册、config/runner（token 与 ntn 调用）
src/tools/    # 四个工具的实现
src/lib/      # 共享工具库（id 解析、schema 提取、ntn runner 等）
test/         # 单元测试（不依赖真实 Notion）
```

## License

MIT

---

<a id="english"></a>
# English

**Four consolidated Notion tools for DeepSeek Harness**, built on Notion's official `ntn` CLI instead of the official Notion MCP server.

The official Notion MCP ships dozens of overlapping tools. This plugin keeps the high-frequency surface to four tools — **search, get, page, query** — so the model carries less schema, picks the right call more reliably, and still covers everyday page/database work. Writes are safe by construction: property values are validated against the data-source schema, a failed post-create PATCH trashes the new page, and `attach` refuses cycles and silent parent overwrites.

### Install

```bash
brew install --cask notion-cli        # or: npm i -g ntn
plugin_manager install_bundle target=/absolute/path/to/dsh-notion
```

### Token

`NOTION_API_TOKEN` env var, or `./notion-token` beside the plugin, or `ntn login`. Share target pages/databases with your Notion integration.

### Usage

```jsonc
{ "tool": "notion_search", "args": { "query": "roadmap", "limit": 10 } }
{ "tool": "notion_get",    "args": { "id_or_url": "<page-or-db-id>" } }
{ "tool": "notion_page",   "args": { "action": "create", "parent": "page:<id>",
                                     "props": { "body_content": "# Title\n\nBody" } } }
{ "tool": "notion_query",  "args": { "database_or_data_source": "<ds-id>",
                                     "filter": { "property": "Done", "checkbox": { "equals": false } } } }
```

`notion_page` takes `action: create | edit | attach | trash`. Two `props` keys are page fields rather than columns: `body_content` is the Markdown body, and `icon` is the page icon (an emoji such as `"🎯"`, an http(s) image URL, or `null` to clear it). Every other `props` key is a property name converted by column type.

### Integration

Each tool is a native DSH `ToolDefinition` registered through `ctx.tools.register`: `name`, `description` and `parameters` are what the model sees, `output.schema` / `output.render` define how a successful canonical value is validated and rendered, and `execute` returns that value (a thrown error becomes the call's error result). DSH has no separate prompt/guideline channel, so usage rules live in the description and the parameter descriptions.

Each tool declares a per-call `timeoutMs` (enforced by `dsh-tool-call-timeout-policy`) and `isConcurrencySafe` (read-only tools run in parallel, `notion_page` stays exclusive), and every `ntn` spawn observes `exec.signal`, so a cancelled or timed-out call kills the child process instead of leaving it running.

### Error codes

DSH renders a thrown error as `Error: <message>` and keeps a structured `{ name, code }` only for its own `HarnessError`; a plain Error's `code` is dropped. This plugin therefore puts the category at the front of the message: `[INVALID_INPUT]`, `[NTN_FAILED]`, `[ABORTED]`, `[PARTIAL_WRITE]` (a failed write whose rollback also failed, so a half-made page remains — the message carries the id to clean up).

### ⚠️ An `edit` body REPLACES the whole page

Passing `props.body_content` (or its alias `content`) to `notion_page action="edit"` runs `ntn pages edit --content`, whose own help says "Markdown content to **replace** the page with". Anything you leave out is deleted, Notion keeps no body version history, and the trash does not bring it back.

```jsonc
// ❌ meaning to fix one section, sending only that section deletes the rest
{ "action": "edit", "id": "<id>", "props": { "body_content": "## just section two" } }

// ✅ changing the body means resending the complete body
{ "action": "edit", "id": "<id>", "props": { "body_content": "<the full corrected page>" } }

// ✅ changing only title / properties / icon: do not pass body_content at all
{ "action": "edit", "id": "<id>", "props": { "icon": "🎯", "Status": "Done" } }
```

**Shrink guard.** Before replacing, `edit` counts the current body and reports the transition in its result (`body_chars_before` / `body_chars_after`, e.g. "正文已整页替换：12000 字 → 340 字"). A replacement that leaves under half the previous text — on a page with at least 200 characters — is refused with `[INVALID_INPUT]` unless `confirm_shrink: true` is also passed. When the current size cannot be read, the guard degrades to "size unknown" and lets the edit through rather than blocking on an unrelated failure.

For long documents: `create` the whole page once and do not `edit` its body afterwards. If a body edit is genuinely needed, either resend the full text or create a new page and `trash` the old one.

### Trash safety

`notion_page action="trash"` classifies its target before calling `ntn pages trash`:

- **A database or data source is refused outright**, even with `yes: true` — removing one destroys its data sources and every row, which stays a human decision.
- **An already-archived target reports success** (`already_archived: true`, `changed: []`) instead of surfacing Notion's `400 Can't edit block that is archived`, so a retry is harmless. Nothing is written, so `changed` stays empty.
- **A page with child pages is refused** with the child ids unless `recursive: true` is also passed, because Notion archives the whole subtree. `yes` and `recursive` are separate consents. The child list is read from `GET v1/blocks/{id}/children` following `next_cursor` to the end: that endpoint pages over **blocks**, so one page of 100 blocks can hide child pages behind paragraphs, and a truncated read would under-report the subtree. The page cap is a runaway guard only, and reaching it refuses the delete rather than guessing.

### Tolerant arguments

The model does not have to memorize exact spellings. Action synonyms (`delete`→`trash`, `update`→`edit`, `move`→`attach`, `new`→`create`), case/hyphen/underscore folding, `"true"`/`"yes"`/`1` for `yes`, numeric strings for `limit`, and full Notion URLs for `id` are all accepted. Misspellings are **not** fuzzy-matched: guessing could perform a different real write.

Any id from `notion_search` works with any tool: `notion_get` falls back page → database → data source, and `notion_query` resolves a database id automatically.

### License

MIT
