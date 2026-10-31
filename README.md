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

// 改正文 / 改列 / 两者都改
{ "action": "edit", "id": "<page-id>", "props": { "body_content": "# 新正文", "Status": "Done" } }

// 挂到父页 / 父行（不传 props，不是文件上传）
{ "action": "attach", "id": "<page-id>", "parent": "page:<parent-id>" }

// 删除（必须 yes:true）
{ "action": "trash", "id": "<page-id>", "yes": true }
```

`props` 是**属性名 → 值**的对象 map，按列类型自动转换（title/rich_text、number、select/status、multi_select、date、checkbox、url/email/phone、people/relation）。`props.body_content` 是保留键，表示页面正文 Markdown，不会被当成列写入。未知列名、只读列、类型不符都会报错并返回可写列清单，绝不静默写错列。

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

## 后续

- 评论读写
- 文件上传（`notion_file`，与 attach 无关）
- 页面 icon / cover
- 更完整的 people / mention 解析

## 开发

```bash
npm install
npm run build        # 打包 dist/index.js（esbuild）
npm test             # 单元测试（mock，不需要 token）
```

插件源码结构：

```
src/dsh/      # DSH Host 适配层（ctx.tools.register、配置、ntn 调用）
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

`notion_page` takes `action: create | edit | attach | trash`; page Markdown goes in `props.body_content`; all other `props` keys are property names converted by column type.

### License

MIT
