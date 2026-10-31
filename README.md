# dsh-notion

**Four consolidated Notion tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — built on Notion's official `ntn` CLI instead of the official Notion MCP server.

简体中文 | [English](#english)

---

## 为什么是 4 个工具，而不是 67 个

Notion 官方 MCP 暴露约 **67 个工具**，其中大量能力重叠、命名分散。工具越多，模型每轮吃的 schema 越多、选错工具的概率越高，实际干活反而更慢。

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
// 新建普通子页（正文放 props.body_content）
{ "action": "create", "parent": "page:<page-id>", "title": "标题",
  "props": { "body_content": "# 标题\n\n正文" } }

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

`props` 是**属性名 → 值**的对象 map，按列类型自动转换（title/rich_text、number、select/status、multi_select、date、checkbox、url/email/phone、people/relation）。非列名的保留键有两个：

| 保留键 | 含义 | 取值 |
| --- | --- | --- |
| `props.body_content` | 页面正文 Markdown | 字符串 |
| `props.icon` | 页面图标 | 单个 emoji（`"🎯"`）、`http(s)` 图片 URL、已构好的 Notion icon 对象（`{"type":"emoji","emoji":"🎯"}`）、或 `null` 清除 |

保留键不会被当成列写入；如果数据源里**真的有**同名列，写入会直接报错而不是猜你的意图。未知列名、只读列、类型不符都会报错并返回可写列清单，绝不静默写错列。

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

因此模型的全部认知只来自 **description + 参数描述**——DSH 没有独立的 prompt/guideline 通道。插件把使用规则（保留键、必填项、回滚语义、分页方式）写在这两处，而不是散落在别处；错误信息里的 `hint_properties` 是纠正错误的第三条通道。

`execute` 返回的是领域值（如 `{ ok, action, id, url, parent, properties, changed }`），文本由 `output.render` 派生，因此同一个定义在原生 function calling 和 PTC（`run_code`）两种呈现方式下都成立。

### 错误码

DSH 把抛出的错误渲染成 `Error: <message>`，只对它自己的 `HarnessError` 保留结构化 `{ name, code }`；普通 Error 的 `code` 会被丢弃。所以本插件把错误类别写进消息开头，确保模型与日志都能看到：

| 前缀 | 含义 | 模型该怎么做 |
| --- | --- | --- |
| `[INVALID_INPUT]` | 参数不可用（未知列名、只读列、保留键冲突、id 非法…） | 读消息里的可写列清单，改参数重试 |
| `[NTN_FAILED]` | `ntn` 本身失败（未登录、无效 token、Notion API 报错、exit ≠ 0） | 检查 token / workspace / 权限，或原样上报 |
| `[ABORTED]` | 调用被取消或超时，子进程已被杀掉 | 通常无需重试，或换更小的查询 |
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

The official Notion MCP ships ~67 overlapping tools. This plugin keeps the high-frequency surface to four tools — **search, get, page, query** — so the model carries less schema, picks the right call more reliably, and still covers everyday page/database work. Writes are safe by construction: property values are validated against the data-source schema, a failed post-create PATCH trashes the new page, and `attach` refuses cycles and silent parent overwrites.

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

### License

MIT
