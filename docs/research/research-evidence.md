# 研究证据说明

本文保存 Claude Code 2.1.296 memory 逆向分析中可以跨机器核对的信息。仓库不保存完整 AST、关系图或 findings，重新检查时需要从相同发布物重新提取和分析。

## 分析目标

| 项目                  | 值                                                                 |
| --------------------- | ------------------------------------------------------------------ |
| 产品                  | Claude Code                                                        |
| 版本                  | 2.1.296                                                            |
| 平台                  | darwin arm64                                                       |
| Claude 二进制 SHA-256 | `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937` |

被分析的业务代码位于 darwin arm64 原生包中的 Bun 单文件可执行程序。

## 分析方法

完整程序约 230 MiB。直接对完整 Mach-O 运行 REA feature trace 超过了 60 秒请求限制，因此分析采用以下步骤：

1. 使用 REA 确认 Mach-O、arm64 和 Bun 单文件结构。
2. 静态读取 Bun `StandaloneModuleGraph`，没有执行目标程序。
3. 使用 REA 分析提取后的 JavaScript 模块。
4. 从完整结果中筛选 memory 相关模块，再进行聚焦分析和源码审计。

## 分析覆盖范围

### 完整 JavaScript 分析

| 项目                         |         值 |
| ---------------------------- | ---------: |
| REA 标记为相关的输入文件数   |      2,372 |
| 文本字节数                   | 46,116,970 |
| 成功解析的 JavaScript 文件数 |      2,366 |
| AST 节点数                   |  9,332,973 |
| Findings 数                  |    197,045 |
| JavaScript 解析失败数        |          0 |

### Memory 子集分析

| 项目                  |         值 |
| --------------------- | ---------: |
| 文件数                |         39 |
| 文本字节数            | 11,726,835 |
| AST 节点数            |  2,779,619 |
| Findings 数           |      9,411 |
| JavaScript 解析失败数 |          0 |

聚焦分析覆盖路径和开关、提示词和作用域、auto-dream、topic 扫描以及账户上下文。

### Extraction 和 dream 聚焦分析

| 项目                  |   值 |
| --------------------- | ---: |
| 文件数                |    2 |
| JavaScript 解析失败数 |    0 |
| Application graph     | 完整 |

该分析确认 Claude Code 的本地 file-mode post-turn extraction 调用显式传入 `maxTurns=5`。Auto-dream 调用方没有传入 `maxTurns`，Claude Code 的通用 fork runner 因而采用 50 个 assistant turns 的默认上限。

### Selector、recall 与生命周期六模块聚焦分析

| 项目                  |                   值 |
| --------------------- | -------------------: |
| 文件数                |                    6 |
| 文本字节数            |            5,749,497 |
| AST 节点数            |            1,413,293 |
| Findings 数           |                2,393 |
| JavaScript 解析失败数 |                    0 |
| Application graph     |             部分完成 |
| Semantic graph        | 部分完成，结果被截断 |

六个 Claude Code JavaScript 模块都成功解析。`chunk-n3ykh62m.js` 的部分扩展关系超过 parent result budget，`chunk-sfn1dbxq.js` 的 semantic analysis 耗尽 worker heap。因此，图中缺少某条关系不能证明对应功能不存在。

## Selector schema

Claude Code 2.1.296 的 file-mode selector 基础输出预算为 512 tokens。当 API 明确拒绝 selector 请求时，客户端最多额外尝试两个符合认证和价格条件的不同模型。普通解析错误或一般 API 错误不会触发该模型 fallback。Provider structured-output schema 如下：

```json
{
  "type": "object",
  "properties": {
    "selected_memories": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": ["selected_memories"],
  "additionalProperties": false
}
```

## 生命周期文本勘误

生命周期说明按已有 Claude Code 2.1.296 静态提取材料中的具体分支核对。以下勘误修正此前摘要把本地 file mode 和 MCP mode 合并描述的问题，没有执行 Claude 程序，也没有重新生成 REA 图。已有图的覆盖限制仍然适用。

| 原始 chunk          | 核对符号和控制流                                                         | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `chunk-9mazb6vn.js` | `Ie()`、`He()`、`PNr()`、本地 fork 返回后的 `u()`，以及 MCP 分支的 `y()` | `88b3a78aab039f408874888d4b2b3e26e4d7c55dd139d0c5f8958bde4ba009ea` |
| `chunk-2dvx15ja.js` | `I7e()`、`M1o()`、`qgt()`，以及本地 lock mtime 和 Storage V5 的时间记录  | `fb2888405977414315178e8bdfc4b80eb2e0e8be1de865675a9b3958c5cc949f` |
| `chunk-kxgzv2t8.js` | `xFo()` 的 lock acquisition、fork/completion 阶段和 abort 分支           | `b2055cc237853b1b23905a53b3996dcc372bc9a5bc74fc2a5061f79efe620d78` |

复查时应对原始 chunk 校验摘要。格式化派生文件仅便于定位，原研究材料的相关窗口为 `chunk-9mazb6vn.js` 的 184 至 298 行和 690 至 1095 行、`chunk-2dvx15ja.js` 的 30 至 159 行，以及 `chunk-kxgzv2t8.js` 的 224 至 457 行。

本地 file-mode extraction 不因新输入单独撤销当前 pass 的写入资格。控制器保存新上下文，并在当前 pass 结束后处理 trailing run。新 prompt 禁止旧 pass 写入的规则属于 MCP 分支，不能推广到本地 extractor 或 dream。

本地 extraction 在 fork 返回后调用 `u()` 前移 cursor，返回 API error 或达到 turn cap 不改变该分支。Fork 抛出异常时不执行该前移。连续未完成后保留 cursor、累计三次再前移的规则来自 MCP 分支的 `y()`。`Ie()` 对用户正文的三个词门槛按空白拆分计算，并没有独立中文分词。

Dream 取得 lock 时记录本次尝试时间，本地分支使用 `.consolidate-lock` 的 mtime，Storage V5 分支保存 PID 和时间。调度据此计算时间门槛和 session 范围。Fork 返回 API error 或没有写入时仍保留时间，abort 分支也保留。只有 fork 阶段抛出异常且未被中止时回滚旧时间，completion 阶段的摘要或通知错误不回滚。此前的成功整理时间和所有失败都回滚表述应废止。

## 用户文本门槛

本节静态核对同一 Claude Code 2.1.296 发布物的 selector 和 extraction 入口，没有执行目标程序，也不推断服务端 flag 的实际值。

| 原始 chunk          | 核对符号                                            | SHA-256                                                            |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `chunk-sfn1dbxq.js` | `C7r()` selector 入口、`xyn()` 的 BM25 分支         | `4c74137eb23221981404d0ca87b765912f83344851d5c132b21857e5685b03da` |
| `chunk-bk5ct2gw.js` | `bct()` 返回 `tengu_mill_orange` flag，默认 `false` | `efbc2d987608904a4a3ad7221f39f6e6afe34c13076d2ce3e4be2d49f43e6dd1` |
| `chunk-9mazb6vn.js` | `Ie()`、`Le()`、`He()` 和 `Ce = 3`                  | `88b3a78aab039f408874888d4b2b3e26e4d7c55dd139d0c5f8958bde4ba009ea` |
| `chunk-3qabb19b.js` | `F()` 统计满足 predicate 的元素个数                 | `ceb8c8490f39408310286cc14cacb1998192c8c34a80724882f988431f1bf5f2` |

`C7r()` 排除 subagent 和内部后台 query source，取最后一条非 `isMeta` 用户消息的文本。传统路径要求 `/\s/.test(text.trim())` 为真，只有首尾空白不满足条件。无内部空白时，只有 `bct()` 为真且清理后的文本包含指定范围内的 CJK 字符才通过。该范围包括日文假名、汉字和韩文音节。相同的 `bct()` 结果也选择 `xyn()` 的 BM25 recall 分支；该例外不是传统 selector 无条件支持 CJK 的规则。格式化派生文件的相关窗口为 `chunk-sfn1dbxq.js` 的 170908 至 170951 行和 173680 至 173713 行，以及 `chunk-bk5ct2gw.js` 的 26075 至 26077 行。

`Ie()` 排除非 user 和 `isMeta` 消息。字符串正文必须按 `/\s+/` 拆分后有至少三个非空词；数组正文要求至少一个独立 text block 达到同一门槛。`Le()` 调用的 `F()` 是计数函数，不是数组过滤函数。不同消息和不同 text block 的词数不合并，没有独立中文分词。格式化派生文件的相关窗口为 `chunk-9mazb6vn.js` 的 248 至 258 行和 278 至 291 行。

## Read 状态与 stale 门槛

本节核对同一 Claude Code 2.1.296 发布物中的 `chunk-sfn1dbxq.js`。原始 chunk 的 SHA-256 为 `4c74137eb23221981404d0ca87b765912f83344851d5c132b21857e5685b03da`。结论来自既有静态提取材料，没有执行目标程序，也没有推断服务端行为。

`HUn()` 对 `(Date.now() - mtime) / 86400000` 向下取整。`Blt()` 在天数小于或等于 1 时返回空字符串，因此 stale 提醒实际从至少 48 小时开始。格式化派生文件的相关窗口为 9771 至 9787 行。此前超过一天的摘要应解释为取整后的天数大于 1。

`QIr()` 在普通文本读取返回后，用当前页面覆盖 `readFileState` 中的 content、timestamp、offset 和 limit。只有自动 token 截断分支在该处附加 `isPartialView`。Write 的 `dno()` 与 validation、Edit 的 validation 检查已读状态和该标记，普通显式 offset/limit 分页不会仅因只显示一页而拒绝 mutation，也不会累计多个页面的覆盖范围。相关窗口为 168315 至 168325 行、38892 至 38912 行、39087 至 39135 行和 196270 至 196328 行。

读取状态与 recall 的完整读取抑制是不同检查。不能把只看过一页就建立 mutation baseline 外推为该文件已经完整进入主会话上下文。

## 重新验证

在另一台机器重新验证这些 Claude Code 2.1.296 客户端结论时，需要取得相同版本的发布物，并先验证 Claude 二进制 SHA-256。然后静态提取 Bun 模块，并重复 JavaScript 分析和源码审计。分析覆盖统计可以用来检查输入范围是否接近原分析。

仓库没有保存完整 AST、关系图或 findings，因此不能从文档恢复完整分析结果。

## 已知限制

- 对完整 Mach-O 的直接 feature trace 超时，所以 JavaScript 分析基于静态提取的 Bun 模块。
- 某些 literal feature trace 在生成图上没有匹配。No match 不能证明功能不存在。
- Selector、recall 与生命周期六模块分析的 application graph 和 semantic graph 不完整，原因是结果预算和 worker heap 限制。
- 结论同时依赖 REA parse 结果和提取模块的直接源码审计。
