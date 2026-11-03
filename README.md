# dsh-notion

**Six consolidated Notion tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — built on Notion's official `ntn` CLI instead of the official Notion MCP server.

简体中文 | [English](#english)

---

## 为什么是 6 个工具，而不是 67 个

Notion 官方 MCP 暴露**数十个**工具（数量随版本变动，60+），其中大量能力重叠、命名分散。工具越多，模型每轮吃的 schema 越多、选错工具的概率越高，实际干活反而更慢。

dsh-notion 的做法是**收敛工具面**：

- 只保留日常使用频率最高的几件事：**找 → 读 → 建 → 改 → 删**，外加**查一张表**
- 工具名就是动作，没有 `action` 参数：`notion_page_create` / `notion_page_edit` / `notion_page_trash` 各自只声明自己**真正接受**的参数，建页时不可能误带 `old_str`，改页时也不可能误带 `database:<id>` 当父级
- 改正文是**查找替换**，不是整页重写——所以没有「整页覆盖」这个灾难面（见下文）
- 基于官方 `ntn` CLI，直连稳定能力，不额外维护一套 API 客户端
- 结构化 JSON 返回，只给模型稳定、精简的字段，不把原始 Notion 对象塞进上下文
- 写操作有安全网：库页属性按 schema 校验、create 失败自动回滚、移动拒绝成环和覆盖、删除有三重保护
- 后续只补充**确实必要**的能力（评论、文件上传等），不为了"全"而堆工具

工具数从 4 变成 6，是因为 `notion_page` 一个工具塞了四个动作，模型光读它就要吃掉一大段描述，还得先用 `action` 选分支才能看到自己真正关心的规则。拆开之后每个描述都短，且**只讲自己那件事**。

## 六个工具

| Tool | 作用 | 典型场景 |
| --- | --- | --- |
| `notion_search` | 按标题搜索工作区（page / database） | 用户说"找一下某页"，还没有 id |
| `notion_get` | 读页面 Markdown，或读数据库/data source 的 schema | 读正文、看有哪些列可写 |
| `notion_page_create` | 新建页面或数据库行 | 新建页、写列、挂父级 |
| `notion_page_edit` | 查找替换正文、改标题/列/图标、移动父级 | 改一句话、补一段、改状态、搬家 |
| `notion_page_trash` | 删除页面或行（带三重保护） | 删掉废弃页 |
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

也可以直接用 git 地址安装。装好后插件行 id 是 `notion-tools`，六个工具出现在工具列表里。

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

### notion_page_create

```jsonc
// 新建普通子页：body_content 和 icon 都是顶层参数，与 title 平级
{ "parent": "page:<page-id>", "title": "标题",
  "body_content": "# 正文标题\n\n正文", "icon": "🎯" }

// 新建数据库行（props 只放真实列）
{ "parent": "data-source:<ds-id>", "title": "任务 A",
  "body_content": "说明",
  "props": { "Status": "进行中", "标签": ["验收"],
             "截止日期": "2026-01-31", "Done": false } }
```

### notion_page_edit

```jsonc
// 查找替换：改一段话
{ "id": "<page-id>", "edits": [
    { "old_str": "旧的那句话", "new_str": "新的那句话" } ] }

// 一次改多处（顺序执行，同一个请求）
{ "id": "<page-id>", "edits": [
    { "old_str": "状态：待办", "new_str": "状态：完成" },
    { "old_str": "旧标题",     "new_str": "新标题" } ] }

// 追加一段：edits 省略或为空 + body_content = 追加到页尾
{ "id": "<page-id>", "body_content": "## 附：补充说明\n\n后补的内容" }

// 删除一段：new_str 传空串
{ "id": "<page-id>", "edits": [ { "old_str": "这段不要了", "new_str": "" } ] }

// 命中多处时全部替换：replace_all_matches 放在那一条 edit 里面
{ "id": "<page-id>", "edits": [
    { "old_str": "TODO", "new_str": "DONE", "replace_all_matches": true } ] }

// 只改列 / 只改图标 / 只改标题
{ "id": "<page-id>", "props": { "Status": "完成" } }
{ "id": "<page-id>", "icon": "https://example.com/logo.png" }
{ "id": "<page-id>", "icon": null }                    // 清除图标
{ "id": "<page-id>", "title": "新标题" }

// 移动父级（原 attach）：与内容修改可以同时给，按 正文 → 属性 → 移动 的顺序执行
{ "id": "<page-id>", "parent": "page:<parent-id>" }
{ "id": "<page-id>", "parent": "page:<parent-id>",
  "edits": [ { "old_str": "搬家了", "new_str": "已归档" } ] }

// 行→行移动且目标已有不同的父级：需要 yes 显式同意覆盖
{ "id": "<row-id>", "parent": "<other-row-id>", "yes": true }
```

### notion_page_trash

```jsonc
{ "id": "<page-id>", "yes": true }
{ "id": "<page-id>", "yes": true, "recursive": true }   // 连同子页面
```

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

## 参数一览

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `notion_page_create` | `parent`（必填）、`title`、`props`、`icon`、`body_content` | `parent` 见下；`props` 只放真实列 |
| `notion_page_edit` | `id`（必填）、`edits`、`body_content`、`props`、`title`、`icon`、`parent`、`yes` | 至少给一项；`edits` 与 `body_content` **互斥**；`yes` 只在行→行覆盖父级时与 `parent` 一起用 |
| `notion_page_trash` | `id`（必填）、`yes`（必填 `true`）、`recursive` | 三种保护见下 |

三个写工具的 `timeoutMs` 都是 180 秒，`isConcurrencySafe` 都是 `false`（每个动作都可能写入）。

`notion_page_edit` 一次调用可以同时做多件事，按**固定顺序**执行：**(1) 正文 → (2) 标题/列/图标 → (3) 移动父级**。`changed` 会逐项报告哪些真的发生了。第 (2)/(3) 步失败时，错误消息会明确说"哪些已经写进去了"——重试前先读它。

**`props` 现在只放真实列**：属性名 → 值 的对象 map，按列类型自动转换（title/rich_text、number、select/status、multi_select、date、checkbox、url/email/phone、people/relation）。正文和图标**不再是** `props` 的保留键，而是顶层参数 `body_content` / `icon`。

这意味着 `props.icon` / `props.body_content` **没有任何特殊含义**了：如果某个 data source 里真有一列叫 `icon` 或 `body_content`，那 `props.icon` / `props.body_content` 写的就是**那一列**。想改页面图标/正文，用顶层参数。

> **兼容别名**：`notion_page_edit` 还认一个 `props.block_update`（拆分前查找替换列表的旧拼法），只在没传 `edits` 时生效，两者同时传会报错。它**不在参数 schema 里**，属于运行期兼容，新代码请直接用顶层 `edits`。

失败时分两种：**未知列名 / 只读列**会返回可写列清单（写进消息文本）；**值类型不符**只指出属性名与期望类型，不列清单。

**`icon` 的取值**：单个 emoji（`"🎯"`）、`http(s)` 图片 URL、已构好的 Notion icon 对象（`{"type":"emoji","emoji":"🎯"}`）、或 `null` 清除。只改图标时不会碰正文和其他列。

**`parent` 的写法**（`create` 与 `edit` 接受的范围**不同**）：

| 写法 | `notion_page_create` | `notion_page_edit`（移动） |
| --- | --- | --- |
| `page:<id>` | 该页面下的子页面 | 移到该页面下（`POST /v1/pages/{id}/move`） |
| `<裸 page id>` | 同上（先确认它确实不是数据库行） | 同上 |
| `<裸 row id>` | 该行所在 data source 下的子行，并设好 Parent-item 关系 | 重新指向该行的 Parent-item 关系 |
| `data-source:<id>` | 该 data source 里的同级行 | ❌ 不接受（加行请用 `create`） |
| `database:<id>` | 通过 `ntn datasources resolve` 解析到它唯一的 data source（多个则报错列出 id，绝不猜） | ❌ 不接受 |

## 查找替换：notion_page_edit 怎么改正文

`notion_page_edit` **没有「整页覆盖」这种模式**。改正文只有两条路，**二选一**：

1. 传 `edits` —— 查找替换（主要方式）
2. `edits` 为空或不传，但传了 `body_content` —— **追加**到页尾

**同时传 `edits` 和 `body_content` 是错误**（`[INVALID_INPUT]`，什么都没写）：这两种是不同性质的内容操作，插件不会猜你想先做哪个。既要改又要追加，就**分两次调用**。

也就是说：**想动哪段就只发哪段，页面上其它内容永远不会因为你没提到而消失。** 这条约束是设计层面的，不是靠守卫救回来的。

### edits 的基本形状

```jsonc
{ "id": "<page-id>", "edits": [
    { "old_str": "要找到的那段原文", "new_str": "替换成这段" },
    { "old_str": "第二处",           "new_str": "第二次替换" } ] }
```

每次编辑最多三个字段：

| 字段 | 含义 |
| --- | --- |
| `old_str` | 要查找的原文（**必填、非空**），必须命中 |
| `new_str` | 替换内容（**必填**）；传 `""` 就是**删除**命中的那段 |
| `replace_all_matches` | 可选，默认 `false`。命中多处时是否全部替换 |

`replace_all_matches` 是**放在每一条 edit 里面**的，不是顶层参数——你可以让一条全部替换、另一条只替换唯一的一处。

一次调用最多 **100** 条 `edits`。

### 五条必须记住的规则

**1. 一次调用的三种结局，取决于「有几条命中」。** 这是 Notion 那条 markdown 接口自己的规则（不是插件在本地预检）：

| 情况 | 结果 |
| --- | --- |
| 全部命中 | **成功**，无告警 |
| 部分命中 | **成功** + `warnings`（`code: "no_match"`），已命中的照常生效、不回滚 |
| 一条都没命中 | **失败**（Notion 返回 `validation_error`，插件报 `[NTN_FAILED]`），**什么都没写** |

```
No matches found for "<old_str>". Fetch the page again and base old_str on the current page text.
```

看到「一条都没命中」的失败，**不要原样重试**（同样的 `old_str` 只会再失败一次），也不要瞎猜着改：用 `notion_get` 重新读一遍页面，从**当前**正文里重建 `old_str`。页面被别人改过、或你自己**前面的**编辑已经改掉了它（见规则 3），都会导致匹配不到。

> 一句话记法：**还有别的命中 → miss 只是告警；全都 miss → 整次失败**。

**2. 匹配到多处时**，若没设 `replace_all_matches: true`，**整次调用被拒绝（`[NTN_FAILED]`），一个字节都不写**：

```
Multiple matches found for "<old_str>". Found N matches...
```

改全部位置就设那条 edit 的 `replace_all_matches: true`；只改一处就**扩大 `old_str` 的上下文**让它唯一（多带上前后几个字）。

> 注意这条和规则 1 的区别：**多处命中**和**一条都没命中**都会拒绝整次调用（两个都来自 Notion 的 `validation_error`）；只有**部分命中**才是"成功 + 告警"。命中多处时优先扩大上下文而不是直接开 `replace_all_matches`——它可能改到你以为只出现一次的地方。
>
> 而且**只有 Notion 知道哪一条是歧义的**：插件不做本地预检，所以它没法提前告诉你"是第几条 `old_str` 命中多处"。看到拒绝后要自己按 `old_str` 判断是哪一条不够独特。

**3. 多条 edits 按顺序执行，且只发一个请求。** 第 2 条编辑看到的是第 1 条改完之后的结果——所以后面那条的 `old_str` **甚至可以命中前面刚插入的文字**。反过来说，如果第 1 条改掉了第 2 条要匹配的原文，第 2 条就会 miss：只要还有别的命中就只是告警，全都 miss 则整次失败。全部编辑在**一次** Notion 请求里提交。

**4. 部分成功：命中的都生效，没命中的进 `warnings`，调用仍算成功。** 这很容易被忽略：

```jsonc
{ "id": "<page-id>", "edits": [
    { "old_str": "存在的文本",   "new_str": "改好了" },
    { "old_str": "不存在的文本", "new_str": "改不动" } ] }
```

返回里 `warnings` 会带上「不存在的文本」那条（`code: "no_match"`），而整体仍是 `ok: true`，且**不会回滚**已生效的编辑。返回里还有几个计数，可以直接核对：

| 字段 | 含义 |
| --- | --- |
| `edits_sent` | 发出的编辑条数 |
| `edits_applied` | 实际生效的条数（= 发出数 − miss 数） |
| `edits_missed` | 没命中的条数（= `code: "no_match"` 的告警数） |

**一定要读 `warnings` / `edits_missed`**，别看到 `ok` 就以为全部都改上了。想把「全部命中」当成硬性要求，就一次只发一条编辑，或核对 `edits_missed === 0`。

> `warnings` 在一切正常时**整个字段都不出现**（不是空数组），并且告警文本是 Notion 原样返回的。

**5. `new_str: ""` 是删除。** 这是删掉一段正文的正式做法——把命中的文本替换成空串。没有单独的 delete-block 参数。

### 五个容易踩的细节

**`old_str` 匹配的是块的纯文本，不是 Markdown。** 如果页面上是 `**加粗BBB**`：

```jsonc
// ✅ 匹配得到，且加粗格式原样保留
{ "old_str": "加粗BBB", "new_str": "加粗CCC" }

// ❌ 带上星号反而匹配不到纯文本
{ "old_str": "**加粗BBB**" }
```

同理，`# 标题`、`> 引用`、`- 列表项` 这些 Markdown 记号不要写进 `old_str`。`notion_get` 返回的是 Markdown，所以**从它里面复制 `old_str` 时要把记号去掉**。

**`new_str` 里的换行决定块结构。** 单个 `\n` 是**同一个块内的换行**（soft break）；`\n\n` 是**分成两个块**。想生成新的段落、标题、列表项，就用 `\n\n` 隔开。

**`old_str` 可以跨块。** 用 `\n` 或 `\n\n` 把相邻两块的文本连起来就能命中跨块的一段，替换时整段按 `new_str` 的块结构重写。

**`truncated: true` 时不要用它来写 `old_str`。** 返回里带 `truncated: true` 表示 Notion 截断了返回的正文——那**不是**完整页面，从里面复制出来的 `old_str` 很可能匹配不到，或匹配到你以为只有一处的地方。读完整页请用 `notion_get`（必要时用 `format="json"`）或读一个更窄的范围。

**`old_str` 不要覆盖到子页面/子数据库块。** 如果 `old_str` 太宽、把嵌入的 `<page url="…">标题</page>` 或 `<database>` 块也包了进去，`new_str` 就会**删掉那个子页面**，Notion 会直接拒绝：

```
[NTN_FAILED] 这次编辑会删除页面 <id> 里的子页面或子数据库，Notion 因此拒绝执行（本次没有写入任何内容）。
old_str 匹配的是整段文本，很容易连带覆盖 `<page url="...">…</page>` 或 `<database ...>` 这类块。
请把 old_str 缩小到那段文字本身（不要包含子页面/子数据库块）…
```

这条拒绝来自 Notion 的 `allow_deleting_content` 保护（插件**故意**不打开它），报成 `[NTN_FAILED]` 但消息是重写过的、会直接告诉你怎么改——**把 `old_str` 缩小到文字本身**，别去换错误码或重试。

注意：`new_str: ""` **删文字**不受这条限制（删文本不需要那个开关）。被拦住的只有"连带删掉子页面/子数据库"这种情况。

### `$` 的转义

`notion_get` 返回的 Markdown 里，`$` 会被转义成 `\$`（避免被当成公式定界符）。**但 `old_str` 要用原始的 `$`**，不要带反斜杠：

```jsonc
// 页面上是 $100
{ "old_str": "$100", "new_str": "$200" }    // ✅
{ "old_str": "\\$100", "new_str": "$200" }  // ❌
```

### 什么时候用追加，什么时候用查找替换

| 想做的事 | 用法 |
| --- | --- |
| 改一句话 / 改数字 / 改状态文字 | `edits`，`old_str` 带足够上下文 |
| 删掉一段 | `edits` 加 `new_str: ""` |
| 在结尾补一段 | `body_content`，`edits` 省略 |
| 在**中间**插一段 | `edits`：把插入点前后的文本当 `old_str`，`new_str` 里带上新内容 |
| 既改又要追加 | 分**两次**调用（`edits` 与 `body_content` 不能同时传） |
| 整页重写 | 没有这种操作。先建新页再 `trash` 旧页，或逐段替换 |

## 删除（trash）的三重保护

`notion_page_trash` 不是对 `ntn pages trash` 的薄包装，它在调用前先判定目标类型：

| 情况 | 行为 |
| --- | --- |
| 目标是 **database / data source** | **直接拒绝**，即使 `yes: true`。删除数据库会连带它的数据源和全部行，破坏性远超删页面，所以交给用户手动确认。 |
| 目标**已在回收站/已归档** | 返回**成功**（`already_archived: true`，且 `changed: []`），不报错。`ntn` 对已归档对象会返回 `400 Can't edit block that is archived`，那看起来像故障并诱导重试，而删除本来就应当幂等。**注意：什么都没写，所以 `changed` 为空**，不要把 `changed` 非空当成已执行删除。 |
| 目标页面**有子页面** | **默认拒绝**，返回子页面 id 列表，提示需要 `recursive: true`。Notion 归档父页面会连带归档整棵子树，调用方必须先看到还会删掉什么。 |
| 目标页面**无子页面** | 正常删除。 |

```jsonc
// 有子页面时，需要显式同意连带删除
{ "id": "<page-id>", "yes": true, "recursive": true }
```

`yes` 与 `recursive` 是两件事：`yes` 表示「我确认要删除」，`recursive` 表示「我确认连同子页面一起删除」。只有 `recursive` 而没有 `yes` 仍然会被拒绝。

子页面检查走 `GET v1/blocks/{id}/children`，会顺着 `next_cursor` **翻到最后一页**再判断。不能只翻一页：该接口是按**块**分页的（默认每页 100 个块），一个大页面里大量段落会把子页面挤到后面的页，漏读就会漏报子页面、进而误判可以删除。翻页上限只作为失控保护（100 页 × 100 块 ≈ 10000 块），真到达上限时**拒绝删除**而不是猜。子块列表读不出来/解析不了时同样**拒绝**——"没能枚举"不等于"没有子页面"。

## 包容输入

模型不需要记住精确拼写。插件在参数层做**类型宽容**，只有无法对应到任何明确意图的输入才报错。

**类型宽容**：`yes` 接受 `true` / `"true"` / `"yes"` / `1` / `"1"`；`limit` 接受数字字符串，小数会被截断（`2.5` → `2`，但 `<= 0` 仍报错）；`id` 接受 UUID、32 位 hex 或**整条 Notion URL**。

**不做的事**：拼写错误不做模糊匹配，`yes` 不接受语义含糊的字符串。猜错可能执行成另一个真实存在的写操作，风险大于收益。

> 工具拆分之后不再有 `action` 的同义词表（`delete`→`trash` 之类）：工具名就是动作，模型直接调用正确的工具，不存在"选错分支"这回事。

**id 类型基本不用记**：`notion_get` 按 page → database → data source 三级回退，`notion_query` 对 database id 自动 resolve，所以 `notion_search` 返回的 id 可以直接给这两个工具。但 `notion_page_edit` / `notion_page_trash` 只接受**页面** id（或数据库行 id）：拿 database/data source id 去改会失败，要把容器写成 `database:<id>` / `data-source:<id>` 传给 `create` 或 `edit` 的 `parent`。

## 设计取舍

- **更少、更稳的 schema**：每个工具的参数都是小对象，减少模型在工具选择上的犹豫和 token 开销。
- **工具名即动作**：`create` / `edit` / `trash` 拆成三个工具，各自只声明自己接受的参数，非法组合在 schema 层就不存在。
- **改正文只有查找替换和追加**：整页覆盖被**移除**了，不是加守卫限制——不存在那个操作，就没有"没写进去的内容消失"这件事。
- **写入可回滚**：`notion_page_create` 是两步写（建页 + 属性 PATCH），第二步失败会自动把新页 trash 掉，并报告 `partial` / `rollback`。
- **关系安全**：`edit` 的 `parent` 在行→行时会做 Parent-item 环检测；覆盖已有父级必须显式 `yes: true`。内容修改与移动可以同时给，**内容先应用**：内容改完了移动才失败，你会看到内容已改、位置未变的报告，而不是两者都白做。
- **不猜列**：`notion_get` 标出可写列和 Parent-item 候选列，写页工具和 `notion_query under` 直接复用同一套选择逻辑。
- **正文走 API 而不是 CLI 的 `--content`**：改正文是 `PATCH v1/pages/{id}/markdown`，不是 `ntn pages edit --content`（后者的 `--content` 语义就是"整页替换"，正是被移除的那个能力）。查找替换语义由 Notion 这个接口原生提供。
- **图标是页面字段，不是列**：Notion CLI 的 `pages create/edit` 没有 `--icon`，插件把顶层 `icon` 归一化后并入同一次属性 PATCH（只有 icon 时发 icon-only 请求），create 时图标也参与回滚判定。

### 返回值

三个写工具的返回值结构一致：必有 `ok: true`、`properties`、`changed`；另有 `id`、`url` 等。

`changed` 的取值只有这几个：`body_content` / `properties` / `icon` / `title` / `parent` / `parent_item_relation` / `trashed`。用它来判断"到底写成了什么"——例如同时给了内容和 `parent` 时，`changed` 里会同时出现 `body_content` 和 `parent`。**空数组 = 有意为之的空操作**（例如已归档页再 trash 一次）。

| 只在对应场景出现的字段 | 含义 |
| --- | --- |
| `created: true` | create 成功 |
| `appended: true` | edit 走了追加路径 |
| `already_archived: true` | trash 空操作（页本来就在回收站） |
| `already_linked: true` | 移动空操作（本来就在那个父级下） |
| `replaced_parent_ids` | 行→行移动覆盖掉的旧父级 |
| `cycle_check` | 页面移动的环检测结果（`walked` / `partial`） |
| `edits_sent` / `edits_applied` / `edits_missed` | 仅在传了 `edits` 时出现 |
| `warnings` | `{code, message}` 数组，**一切正常时整个字段缺席**（不是空数组） |
| `truncated: true` | 返回的正文被截断，**不是**完整页面 |

`warnings` 里的文本是 Notion 原样返回的，不加工。

## DSH 集成方式

每个工具都是一个原生 DSH `ToolDefinition`，直接 `ctx.tools.register`：

```ts
{
  name, description, parameters,      // 模型可见：名称 + 描述 + JSON Schema（DSH 强制子集）
  output: { schema, render },         // 返回值的规范 JSON 契约 + 渲染成文本块
  execute(args, exec)                 // 工具体：返回规范值，抛错即失败结果
}
```

因此模型的全部认知只来自 **description + 参数描述**——**单个工具定义**没有独立的 prompt/guideline 字段。DSH 另有 `ctx.systemPrompt.section()` 可以在系统提示里加段落，本插件故意不用：6 个工具的规则放在各自的 description 里更贴近使用现场。插件把使用规则（查找替换语义、必填项、回滚语义、分页方式）写在这两处，而不是散落在别处。

`execute` 返回的是领域值（如 `{ ok, id, url, changed, warnings }`），文本由 `output.render` 派生，因此同一个定义在原生 function calling 和 PTC（`run_code`）两种呈现方式下都成立。

**注意 `details` 不会到模型**：DSH 只把抛出的 `message` 渲染成 `Error: <message>`，错误对象上的 `.details`（含 `hint_properties`）仅用于测试和日志。所以可写列清单是被**写进消息文本**的，不是靠 `details` 传递。同理，部分成功的告警写进返回值的 `warnings`，因为它们**必须**被模型看到。

### 错误码

DSH 把抛出的错误渲染成 `Error: <message>`，只对它自己的 `HarnessError` 保留结构化 `{ name, code }`；普通 Error 的 `code` 会被丢弃。所以本插件把错误类别写进消息开头，确保模型与日志都能看到：

| 前缀 | 含义 | 模型该怎么做 |
| --- | --- | --- |
| `[INVALID_INPUT]` | 参数不可用（未知列名、只读列、id 非法、`edits` 格式不对…） | 读消息里的可写列清单 / 提示，改参数重试 |
| `[NTN_FAILED]` | `ntn` 本身失败（未登录、无效 token、Notion API 报错、exit ≠ 0） | 检查 token / workspace / 权限，或原样上报 |
| `[ABORTED]` | 调用**被取消**（子进程已被 SIGTERM）。注意：DSH 层超时不走这个码——`dsh-tool-call-timeout-policy` 会报 `TOOL_TIMEOUT`；`ntn` 自己的进程超时归入 `[NTN_FAILED]` | 通常无需重试，或换更小的查询 |
| `[PARTIAL_WRITE]` | 后续写入失败且回滚也失败，工作区留下了半成品 | 用消息中给出的 id 手动 `trash` 或 `edit` 清理 |
| `[NTN_FAILED]`（`details.refused = "deleting_child_content"`） | 这次编辑会连带删掉页面里嵌入的**子页面/子数据库**，Notion 的 `allow_deleting_content` 保护拒绝执行（插件故意不开这个开关）。消息是重写过的，不是原样 ntn 输出 | 把 `old_str` 缩小到那段文字本身，避开 `<page>`/`<database>` 块 |

成功回滚的 create 不报 `[PARTIAL_WRITE]`，而是保留真正失败的那个类别（`[NTN_FAILED]` / `[INVALID_INPUT]`），并附带 `partial: false`。

`notion_page_edit` 的三种命中结局里只有「部分命中」不是错误：命中多处和一条都不命中，都是由 Notion 返回 `validation_error`、插件原样报成 `[NTN_FAILED]`，且**整次无写入**（插件不做本地预检，所以这两种都来自 Notion 本身）；部分命中是成功 + `warnings`。

## 后续

- 评论读写
- 文件上传（`notion_file`）
- 页面 cover（icon 已支持顶层 `icon`）
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
src/tools/    # 工具实现：search / get / query / page（create、edit、trash 三个工具）
src/lib/      # 共享工具库（id 解析、schema 提取、ntn runner 等）
test/         # 单元测试（不依赖真实 Notion）
```

## License

MIT

---

<a id="english"></a>
# English

**Six consolidated Notion tools for DeepSeek Harness**, built on Notion's official `ntn` CLI instead of the official Notion MCP server.

The official Notion MCP ships dozens of overlapping tools. This plugin keeps the high-frequency surface small — **search, get, query, and the page write trio create / edit / trash** — so the model carries less schema, picks the right call more reliably, and still covers everyday page/database work. Each tool is named for the action it performs; there is no `action` parameter, so `notion_page_create` cannot accidentally receive an `old_str` and `notion_page_edit` cannot accidentally receive a create-only argument. Writes are safe by construction: property values are validated against the data-source schema, a failed post-create PATCH trashes the new page, edits are find-and-replace so untouched text can never vanish, and moves refuse cycles and silent parent overwrites.

### Install

```bash
brew install --cask notion-cli        # or: npm i -g ntn
plugin_manager install_bundle target=/absolute/path/to/dsh-notion
```

### Token

`NOTION_API_TOKEN` env var, or `./notion-token` beside the plugin, or `ntn login`. Share target pages/databases with your Notion integration.

### Usage

```jsonc
{ "tool": "notion_search",      "args": { "query": "roadmap", "limit": 10 } }
{ "tool": "notion_get",         "args": { "id_or_url": "<page-or-db-id>" } }
{ "tool": "notion_page_create", "args": { "parent": "page:<id>", "title": "Title",
                                          "body_content": "# Title\n\nBody" } }
{ "tool": "notion_page_edit",   "args": { "id": "<page-id>", "edits": [
                                          { "old_str": "Status: TODO", "new_str": "Status: DONE" } ] } }
{ "tool": "notion_page_trash",  "args": { "id": "<page-id>", "yes": true } }
{ "tool": "notion_query",       "args": { "database_or_data_source": "<ds-id>",
                                          "filter": { "property": "Done", "checkbox": { "equals": false } } } }
```

`body_content` (the Markdown body) and `icon` (an emoji such as `"🎯"`, an http(s) image URL, or `null` to clear) are **top-level parameters**, siblings of `title`. `props` is only a map of real database columns: `props.icon` and `props.body_content` carry **no special meaning** any more, so on a data source that really has a column named `icon` or `body_content` those keys write that column. Use the top-level parameters for the page's icon and body.

`parent` means different things to the two tools. For **`notion_page_create`**: `page:<id>` (child page), a bare page id (same, after checking it is not a database row), a bare row id (child row in that row's data source, with the Parent-item relation set), `data-source:<id>` (peer row), or `database:<id>` (resolved through `ntn datasources resolve` to its unique data source — several ids are an error, never a guess). For **`notion_page_edit`** (a move) only page forms are accepted — `page:<id>`, a bare page id, or a bare row id to re-link that row's Parent-item relation; `database:<id>` and `data-source:<id>` are refused, because adding a row is `create`'s job.

### Create

`notion_page_create` needs `parent` — `page:<id>`, `database:<id>`, `data-source:<id>`, or a bare database row id (a child row linked through the data source's Parent-item / self-relation column). Properties, icon and Parent-item link are applied by a second request; if that request fails the new page is trashed so no half-made page is left behind, and the error reports `rollback` (`trashed` / `trash_failed` / `unknown_id`) plus `partial: true` if something was left behind. A page in a database also needs a title: the `title` parameter, the title property in `props`, or a leading `# Heading` of `body_content`.

### Edit — find and replace

`notion_page_edit` has **no whole-page replace mode**. There are exactly two ways to change a body, and they are **mutually exclusive**:

1. Pass `edits` — find and replace (the normal path).
2. Omit `edits` (or pass it empty) **and pass `body_content`** — append to the end of the page.

Passing **both** `edits` and `body_content` is an `[INVALID_INPUT]` error with nothing written: they are different content operations, and the plugin will not guess which one you meant. To change *and* append, make **two calls**.

So you only ever send the part you mean to touch, and text you did not mention can never be lost.

```jsonc
{ "id": "<page-id>", "edits": [
    { "old_str": "the exact old text", "new_str": "the replacement" },
    { "old_str": "text that appears often", "new_str": "replaced everywhere",
      "replace_all_matches": true } ] }
```

Each edit is `{ old_str, new_str, replace_all_matches? }`. `old_str` and `new_str` are both **required**; `old_str` must be non-empty and `new_str` may be `""`, which **deletes** the matched text. `replace_all_matches` belongs **on the individual edit**, not the top level, so one edit can replace every occurrence while another replaces a unique one. At most **100** edits per call.

- **`old_str` must match exactly, and the outcome depends on how many edits match** (this is Notion's rule for the markdown endpoint, not a local pre-check):

  | How many match | Result |
  | --- | --- |
  | All of them | **Success**, no warnings |
  | Some of them | **Success** + `warnings` (`code: "no_match"`); the matches are applied, nothing is rolled back |
  | **None of them** | **Failure** — Notion returns `validation_error`, surfaced as `[NTN_FAILED]`; **nothing is written** |

  A total miss reads `No matches found for "<old_str>". Fetch the page again and base old_str on the current page text.` **Do not simply retry the same `old_str`** — it will fail identically. Re-read with `notion_get` and rebuild `old_str` from the *current* body; the page may have changed, or an earlier edit may already have consumed that text.
- **More than one match refuses the whole call (`[NTN_FAILED]`); nothing is written.** `Multiple matches found for "<old_str>". Found N matches...` Either add surrounding context to make `old_str` unique, or set `replace_all_matches: true` on that edit. This is a separate case from a total miss.
- **Multiple edits run sequentially in one request.** Edit 2 sees edit 1's result — a later `old_str` can match text an earlier edit just inserted, and conversely an earlier edit can consume the text a later one was going to match (which then misses; fatal only if *nothing* else matches). All edits are submitted in a single request.
- **Partial success is easy to miss.** When some edits match, the result carries `edits_sent`, `edits_applied` (= sent − misses) and `edits_missed` (= count of `no_match` warnings). **Always read `warnings` / `edits_missed`** — `ok` does not mean every edit landed. If you need all-or-nothing, send one edit per call or assert `edits_missed === 0`.
- **`warnings` is omitted entirely when everything matched** (it is absent, never an empty array), and its text is echoed verbatim from Notion.

So three outcomes, three different signals: *multiple matches* refuses everything, *no match at all* fails everything, and only *partial* is a success that still needs checking.

And **only Notion knows which edit was ambiguous** — the plugin does no local pre-check, so it cannot tell you in advance that "edit #2 matches more than once". After a refusal, work out from your own `old_str` values which one was insufficiently unique.

Five details that bite:

- **`old_str` matches the block's plain text, not the markdown.** `old_str: "boldtext"` matches inside `**boldtext**` and the bold formatting survives. Do not include `**`, `_`, `#`, `>` or `-` markers — and remember that `notion_get` returns markdown, so strip the markers when copying an `old_str` out of it.
- **Newlines in `new_str` decide block structure.** A single `\n` is a line break inside one block; `\n\n` starts a separate block. `old_str` may span blocks using `\n` or `\n\n`.
- **`$` is escaped as `\$` in the markdown `notion_get` returns, but `old_str` must use the plain `$`.**
- **Never build an `old_str` from a `truncated: true` result.** That marks a body Notion truncated, so it is not the full page and a copied `old_str` may match nothing — or match somewhere you did not expect.
- **An `old_str` must not span a child-page or child-database block.** If it is broad enough to swallow an embedded `<page url="…">title</page>` or `<database>` block, the `new_str` would *delete that child page*, and Notion refuses the edit. The plugin deliberately does not send `allow_deleting_content`, so the refusal arrives as `[NTN_FAILED]` with a rewritten message telling you to narrow `old_str` to the text itself — do that; do not change the error code or retry. Note that `new_str: ""` deleting plain **text** is unaffected (that needs no such flag); only deleting nested pages/databases is blocked.

### Edit — properties, title, icon, move

`notion_page_edit` needs `id` plus at least one of `edits` / `body_content` / `title` / `props` / `icon` / `parent`. `props` carries real columns only. A lone `icon` change never disturbs the body or other properties.

One call can combine all of these. They run in a **fixed order — (1) body, (2) title/props/icon, (3) parent move** — and `changed` reports each one that actually happened. If step (2) or (3) fails after the body was already written, the error says exactly what already landed; read it before retrying.

`parent` moves the page, absorbing the old `attach` action: `page:<id>` (or a bare page id) re-parents via `POST /v1/pages/{id}/move`, and a bare row id re-links that row's Parent-item relation. It is not a file upload, and database/data-source parents are not accepted here — add a row with `notion_page_create`. Cycle-forming moves are refused. Re-linking a row that already has a *different* parent requires `yes: true` (otherwise it refuses and shows the current parent ids); `yes` without `parent` is an error.

### Trash safety

`notion_page_trash` classifies its target before calling `ntn pages trash`:

- **A database or data source is refused outright**, even with `yes: true` — removing one destroys its data sources and every row, which stays a human decision.
- **An already-archived target reports success** (`already_archived: true`, `changed: []`) instead of surfacing Notion's `400 Can't edit block that is archived`, so a retry is harmless. Nothing is written, so `changed` stays empty.
- **A page with child pages is refused** with the child ids unless `recursive: true` is also passed, because Notion archives the whole subtree. `yes` and `recursive` are separate consents. The child list is read from `GET v1/blocks/{id}/children` following `next_cursor` to the end: that endpoint pages over **blocks**, so one page of 100 blocks can hide child pages behind paragraphs, and a truncated read would under-report the subtree. The page cap (100 pages × 100 blocks ≈ 10 000 blocks) is a runaway guard only, and reaching it refuses the delete rather than guessing. An unreadable or unparseable child list also refuses: "could not enumerate" is not "has no children".

### Tolerant arguments

The model does not have to memorize exact spellings. `"true"`/`"yes"`/`1` for `yes`, numeric strings for `limit`, and full Notion URLs for `id` are all accepted. Misspellings are **not** fuzzy-matched: guessing could perform a different real write. With the action split there is no longer an action-synonym table — the tool name *is* the action.

Any id from `notion_search` works with any tool: `notion_get` falls back page → database → data source, and `notion_query` resolves a database id automatically.

### Integration

Each tool is a native DSH `ToolDefinition` registered through `ctx.tools.register`: `name`, `description` and `parameters` are what the model sees, `output.schema` / `output.render` define how a successful canonical value is validated and rendered, and `execute` returns that value (a thrown error becomes the call's error result). DSH has no separate prompt/guideline channel, so usage rules live in the description and the parameter descriptions.

Each tool declares a per-call `timeoutMs` (enforced by `dsh-tool-call-timeout-policy`) and `isConcurrencySafe` (the read-only tools — `notion_search`, `notion_get`, `notion_query` — run in parallel; the three page write tools stay exclusive, all with a 180 s budget), and every `ntn` spawn observes `exec.signal`, so a cancelled or timed-out call kills the child process instead of leaving it running.

Body writes go through `PATCH v1/pages/{id}/markdown` rather than `ntn pages edit --content` — the CLI flag's semantics are "replace the page with", which is exactly the capability that no longer exists here. Property, icon and Parent-item writes remain `PATCH v1/pages/{id}`.

All three write tools return the same shape: always `ok: true`, `properties` and `changed`; plus `id`, `url` and the other fields listed above where they apply. `changed` uses a closed vocabulary — `body_content`, `properties`, `icon`, `title`, `parent`, `parent_item_relation`, `trashed` — so it is how you tell what actually landed (a combined content edit plus move lists both `body_content` and `parent`); an empty array is a deliberate no-op. `warnings` is an array of `{ code, message }`, echoed verbatim from Notion, and the field is **omitted entirely when there is nothing to say** — never an empty array.

### Error codes

DSH renders a thrown error as `Error: <message>` and keeps a structured `{ name, code }` only for its own `HarnessError`; a plain Error's `code` is dropped. This plugin therefore puts the category at the front of the message: `[INVALID_INPUT]`, `[NTN_FAILED]`, `[ABORTED]`, `[PARTIAL_WRITE]` (a failed write whose rollback also failed, so a half-made page remains — the message carries the id to clean up). One `[NTN_FAILED]` sub-case is worth recognizing: an edit that would delete a nested child page or database comes back with `details.refused = "deleting_child_content"` and a rewritten message (not raw ntn output) telling you to narrow `old_str` past the `<page>`/`<database>` block.

Of the three find-and-replace outcomes only the partial one is not an error: a multiple match and a total miss both come back from Notion as `validation_error` and are surfaced as `[NTN_FAILED]` with nothing written (the plugin does no local pre-check, so both originate with Notion). **A partial match is not an error at all** — it is a success carrying `warnings`.

### License

MIT
