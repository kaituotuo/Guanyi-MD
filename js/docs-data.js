/**
 * 预设文档（file:// 协议下 fetch 不可用时的内嵌数据，与 docs/*.md 保持同步）
 * 数组模型：{ id, name, content }
 */
window.PRESET_DOCS = [
  {
    id: 'builtin-product-intro',
    name: '产品介绍',
    content: `# 观绎 MD

**Guanyi‑MD｜俯仰观物，绎述我心。**

一款以本心为源的 Markdown 编辑器，观览万象，抽绎所思。

## 名字由来

“观”出自《周易・系辞上》：“仰以观于天文，俯以察于地理。”

以己身为主体，怀好奇之心，敏锐观照天地万象，不随外物偏移，守“以我为主”之本。

“绎”出自《论语・子罕》：“巽与之言，能无说乎？绎之为贵。”

绎，抽丝理绪，推阐本心。将观察所得内化沉淀，再把所思所想梳理、发送、表达于文字。

观绎 MD 不以工具束缚人，而为人承载思想。向外观万物，向内绎本心，以书写者为中心，把内在思考交付笔墨。

## 产品简介

观绎 MD 是一款无需安装、双击即可使用的本地优先 Markdown 阅读编辑器。它适用于 Markdown 与 TXT 文档；在此基础上，还可通过“添加目录”持续接入本地文档，并使用“智能审阅”完成人工批注和 AI 辅助阅读。

## 适用场景

- 阅读、撰写和整理产品方案、会议记录、笔记与技术文档
- 校对或二次编辑 AI / 智能体生成的 Markdown 内容
- 在离线或内网环境中完成轻量写作
- 将 Markdown 导出为 PDF、PNG 或原始 \`.md\` 文件

## 核心能力

1. **三种编辑视图**：在源码、预览和分栏之间自由切换。
2. **常用格式工具**：支持标题、粗体、斜体、列表、引用、代码和表格。
3. **本地文档管理**：新建文档、打开本地文件，并在浏览器中自动保存编辑进度。
4. **撤销与恢复**：每份文档保留独立的最近编辑历史。
5. **多格式导出**：下载 Markdown 原文，或导出为 PDF 和长图。
6. **添加目录**：授权多个本地文件夹，扫描 5 层内的 Markdown 与 TXT 文档，按原目录层级集中浏览和编辑。
7. **安全写回**：保存到原文件，并在外部文件变化时保护当前编辑。
8. **智能审阅：人工批注**：为精确文字或整块内容添加批注，查看、修改、删除并自动生成 AI 可读伴随文件，Markdown 正文保持不变。
9. **智能审阅：AI 辅助阅读**：记录阅读进度，并可使用用户配置的 OpenAI 兼容模型生成重点、关键细节和易错冲突提醒，结果引用可定位原文。
10. **模型与密钥安全**：连接测试不发送正文；API Key 默认只保存在当前会话，浏览器直连受限时可使用不落盘的本机安全转发。

## 协作扩展进展

- 已实现：目录接入、树形浏览、原文件写回、冲突保护，以及“智能审阅”中的人工批注、伴随文件、阅读进度和 AI 辅助阅读。
- 延期：反馈任务、自动改写、修改对比与逐项确认。

## 数据与文件

- 浏览器文档保存在 \`localStorage\` 中。
- 使用 Chrome 或 Edge 打开的本地文件，可在授权后写回原文件。
- 本地文件从侧栏移除时，磁盘中的原文件仍会保留。
- AI 辅助阅读只在用户主动生成时发送当前 Markdown；API Key 默认仅保存在当前会话，不写入源码、正文、伴随文件或项目文件。

## 开始使用

从左侧选择一份文档即可阅读或编辑；也可点击“添加目录”接入本地 Markdown 与 TXT 文档。选择文字后点击工具栏“智能审阅”组合图标，可开始人工批注；抽屉中还可切换到“AI 辅助阅读”。`
  },
  {
    id: 'builtin-feature-demo',
    name: '功能演示',
    content: `# Markdown 功能演示

这份文档用于体验编辑器支持的常用 Markdown 格式。

## 基础格式

普通文字可以包含 **加粗**、*斜体*、~~删除线~~ 和 \`行内代码\`。

> 引用适合突出结论、提示或需要特别关注的内容。

## 列表示例

### 无序列表

- 源码视图适合精确编辑
- 预览视图适合阅读和校对
- 分栏视图可以边写边看效果

### 有序列表

1. 选择或新建文档
2. 输入 Markdown 内容
3. 保存或导出成果

### 任务列表

- [x] 切换一次视图
- [ ] 尝试使用格式工具栏
- [ ] 导出一份 Markdown 文件

## 表格

| 功能 | 用途 | 状态 |
|------|------|------|
| 实时预览 | 检查排版效果 | 可用 |
| 本地保存 | 保留写作成果 | 可用 |
| PDF 导出 | 分享阅读版本 | 可用 |

## 代码块

\`\`\`javascript
function renderMarkdown(source) {
  return marked.parse(source, { gfm: true });
}
\`\`\`

## 链接与分割线

[了解 CommonMark](https://commonmark.org/)

---

现在可以直接修改这份文档，观察源码与预览如何同步更新。`
  },
  {
    id: 'builtin-general-template',
    name: '通用模板',
    content: `# 文档标题

> 用一句话说明这份文档要解决的问题或传达的核心结论。

## 背景

补充必要的上下文、现状和约束。

## 目标

- 目标一
- 目标二
- 目标三

## 方案

### 关键思路

描述方案的主要结构和判断依据。

### 执行步骤

1. 第一步
2. 第二步
3. 第三步

## 计划

| 阶段 | 负责人 | 计划时间 | 状态 |
|------|--------|----------|------|
| 准备 | 待填写 | 待填写 | 未开始 |
| 执行 | 待填写 | 待填写 | 未开始 |
| 验收 | 待填写 | 待填写 | 未开始 |

## 待办

- [ ] 补充背景资料
- [ ] 确认方案范围
- [ ] 完成最终检查

## 备注

记录补充信息、风险或后续行动。`
  },
  {
    id: 'builtin-product-intro-en',
    name: '产品介绍（英文）',
    content: `# Guanyi‑MD

**观绎 MD｜俯仰观物，绎述我心。**

## Overview

Guanyi‑MD is a local-first Markdown reader and editor centered on the writer. It runs directly in Chrome or Edge, works with any Markdown document, can ingest local folders, and provides Smart Review for human comments and user-triggered AI-assisted reading.

## Common Use Cases

- Read, draft, and organize plans, notes, and technical documentation
- Review and refine AI-generated Markdown
- Write in offline or intranet environments
- Export content as Markdown, PDF, or a full-page PNG

## Key Features

1. **Three editing views**: Source, Preview, and Split.
2. **Formatting tools**: Headings, emphasis, lists, quotes, code, and tables.
3. **Local document management**: Create browser documents or open local text files.
4. **Undo and redo**: Each document keeps its own recent editing history.
5. **Flexible export**: Download the Markdown source or export the rendered preview.
6. **Add Folder**: Authorize multiple Markdown folders and browse their original hierarchy.
7. **Safe write-back**: Save to the original file with external-change conflict protection.
8. **Smart Review — comments**: Comment on exact text or a whole block, then view, edit, delete, and generate AI-readable sidecars without changing the Markdown body.
9. **Smart Review — AI-assisted reading**: Track reading progress and use a user-configured OpenAI-compatible model for highlights, key details, and conflict warnings with source locations.
10. **Model and key safety**: Connection tests do not send the document. API keys are session-only by default, and an optional loopback-only proxy handles browser network restrictions without persisting requests.

## Collaboration Extension Status

- Implemented: folder ingestion, tree browsing, write-back, conflict protection, comments, review sidecars, reading progress, and AI-assisted reading.
- Postponed: feedback tasks, automatic rewriting, change comparison, and item-by-item confirmation.

## Data and Files

- Browser documents are stored in \`localStorage\`.
- Files opened through Chrome or Edge can be written back after permission is granted.
- Removing a local file from the sidebar does not delete the original file from disk.
- The current Markdown is sent only when the user generates reading assistance. API keys stay session-only by default and never enter the document or review sidecars.

## Get Started

Choose a document from the sidebar to read or edit, or use Add Folder to bring a local Markdown folder into the document tree. Select text and use the toolbar Smart Review icon to open Comments or AI-assisted Reading.`
  }
];
