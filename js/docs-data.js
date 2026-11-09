/**
 * 预设文档（file:// 协议下 fetch 不可用时的内嵌数据，与 docs/*.md 保持同步）
 * 数组模型：{ id, name, content }
 */
window.PRESET_DOCS = [
  {
    id: 'builtin-product-intro',
    name: '产品介绍',
    content: `# 观译阅读器

**Guanyi Reader｜让阅读、摘录与思考留在本地。**

支持 Markdown、TXT、PDF 和 EPUB 的本地阅读与批注工具。

## 产品简介

观译阅读器支持打开本地 Markdown、TXT、PDF 和 EPUB，工具栏随文档格式切换。Markdown 与 TXT 保留正文编辑能力；PDF 与 EPUB 提供阅读、高亮、批注和笔记。桌面客户端保留阅读记录，也可在浏览器中使用本地文档功能。

## 适用场景

- 阅读、撰写和整理产品方案、会议记录、笔记与技术文档
- 阅读 PDF 资料，添加高亮和批注，另存含批注的 PDF
- 按章节阅读 EPUB 电子书，调整字号并导出摘录与笔记
- 校对或二次编辑 AI / 智能体生成的 Markdown 内容
- 在离线或内网环境中完成轻量写作
- 将 Markdown 导出为 PDF、PNG 或原始 \`.md\` 文件

## 核心能力

1. **Markdown 编辑**：在源码、预览和分栏之间自由切换，支持标题、粗体、列表、引用、代码和表格。
2. **TXT 阅读与编辑**：保留原始文字和换行，支持纯文本阅读与修改。
3. **PDF 阅读与批注**：翻页、缩放、查找，添加高亮、批注和笔记，另存含批注的 PDF。
4. **EPUB 阅读与笔记**：章节目录、分页、字号调整和阅读位置恢复；高亮与笔记自动保存在本机，可导出 Markdown 笔记。
5. **Markdown 导出与历史**：保留最近编辑历史，可导出 Markdown 原文、PDF 和长图。
6. **添加目录**：授权多个本地文件夹，扫描 5 层内的 Markdown 与 TXT 文档，按原目录层级集中浏览和编辑。
7. **文本安全写回**：Markdown 与 TXT 保存到原文件，并在外部文件变化时保护当前编辑。
8. **Markdown 智能审阅：人工批注**：为精确文字或整块内容添加批注，查看、修改、删除并自动生成 AI 可读伴随文件，Markdown 正文保持不变。
9. **Markdown AI 辅助阅读**：记录阅读进度，并可使用用户配置的 OpenAI 兼容模型生成重点、关键细节和易错冲突提醒，结果引用可定位原文。
10. **模型与密钥安全**：连接测试不发送正文；API Key 默认只保存在当前会话，浏览器直连受限时可使用不落盘的本机安全转发。

## 协作扩展进展

- 已实现：目录接入、树形浏览、原文件写回、冲突保护，以及“智能审阅”中的人工批注、伴随文件、阅读进度和 AI 辅助阅读。
- 延期：反馈任务、自动改写、修改对比与逐项确认。

## 数据与文件

- 文本编辑进度和阅读记录保存在本机；PDF 批注草稿与 EPUB 原文件使用本地缓存。
- 使用 Chrome 或 Edge 打开的 Markdown 与 TXT，可在授权后写回原文件。
- PDF 使用“另存为”导出含批注的文件；EPUB 原书保持不变，高亮与笔记保存在应用中并可单独导出。
- 本地文件从侧栏移除时，磁盘中的原文件仍会保留。
- AI 辅助阅读只在用户主动生成时发送当前 Markdown；API Key 默认仅保存在当前会话，不写入源码、正文、伴随文件或项目文件。

## 开始使用

点击“打开文档”选择 Markdown、TXT、PDF 或 EPUB。Markdown 与 TXT 可直接编辑；PDF 与 EPUB 使用阅读工具栏添加高亮和笔记。“添加目录”可持续接入 Markdown 与 TXT 文库；Markdown 的“智能审阅”提供人工批注和 AI 辅助阅读。`
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
    content: `# Guanyi Reader

**观译阅读器｜让阅读、摘录与思考留在本地。**

## Overview

Guanyi Reader is a local reading and annotation tool for Markdown, TXT, PDF, and EPUB. It edits Markdown and TXT text and provides highlights, comments, and notes for PDF and EPUB. The toolbar adapts to the open format while retaining a consistent icon style.

## Common Use Cases

- Read, draft, and organize plans, notes, and technical documentation
- Read and annotate PDF reference material, then save a PDF with annotations
- Read EPUB books by chapter and export excerpts and notes
- Review and refine AI-generated Markdown
- Write in offline or intranet environments
- Export content as Markdown, PDF, or a full-page PNG

## Key Features

1. **Markdown editing**: Source, Preview, and Split views with headings, emphasis, lists, quotes, code, and tables.
2. **TXT reading and editing**: Read and edit plain text while preserving its original line breaks.
3. **PDF reading and annotations**: Page navigation, zoom, search, highlights, comments, and notes; save a PDF containing annotations.
4. **EPUB reading and notes**: Chapters, pagination, font sizes, restored reading position, highlights, and notes exported as Markdown.
5. **Markdown export and history**: Undo or redo recent edits and export Markdown source, PDF, or a full-page PNG.
6. **Add Folder**: Authorize multiple Markdown folders and browse their original hierarchy.
7. **Safe text write-back**: Save Markdown and TXT to the original file with external-change conflict protection.
8. **Markdown Smart Review — comments**: Comment on exact text or a whole block, then view, edit, delete, and generate AI-readable sidecars without changing the Markdown body.
9. **Markdown AI-assisted reading**: Track reading progress and use a user-configured OpenAI-compatible model for highlights, key details, and conflict warnings with source locations.
10. **Model and key safety**: Connection tests do not send the document. API keys are session-only by default, and an optional loopback-only proxy handles browser network restrictions without persisting requests.

## Collaboration Extension Status

- Implemented: folder ingestion, tree browsing, write-back, conflict protection, comments, review sidecars, reading progress, and AI-assisted reading.
- Postponed: feedback tasks, automatic rewriting, change comparison, and item-by-item confirmation.

## Data and Files

- Text progress and reading records are stored locally; PDF annotation drafts and original EPUB files use a local cache.
- Markdown and TXT files opened through Chrome or Edge can be written back after permission is granted.
- Save As exports a PDF containing annotations. EPUB originals stay unchanged; their highlights and notes are stored in the app and exported separately.
- Removing a local file from the sidebar does not delete the original file from disk.
- The current Markdown is sent only when the user generates reading assistance. API keys stay session-only by default and never enter the document or review sidecars.

## Get Started

Use Open Document to choose Markdown, TXT, PDF, or EPUB. Edit Markdown and TXT directly, or use the PDF and EPUB reading tools to highlight passages and add notes. Add Folder brings Markdown and TXT folders into the document tree. Markdown Smart Review provides comments and AI-assisted reading.`
  }
];
