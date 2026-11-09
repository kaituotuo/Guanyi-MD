# 观译阅读器

**Guanyi Reader · 让阅读、摘录与思考留在本地。**

观译阅读器是一款本地优先的文本阅读与批注工具，支持 Markdown、TXT、PDF 和 EPUB。用同一套文档列表与页签组织阅读，打开不同格式时自动切换顶部工具栏，保留统一的图标风格。

| 格式 | 阅读与编辑 | 保存与导出 |
| --- | --- | --- |
| Markdown | 源码、预览、分栏；常用格式、表格、任务列表、图片与批注 | 保存原文、另存、移动；导出 Markdown、PDF、PNG |
| TXT | 中文编码识别、长行换行、段落阅读与纯文本编辑 | 保存原文本与换行 |
| PDF | 官方 PDF.js 阅读器；翻页、缩放、查找、高亮、文字笔记和评论 | 本地保留批注草稿，另存含原生批注的 PDF |
| EPUB | epub.js；章节、字号、阅读位置、高亮、摘录与笔记 | 标注保存在应用内，可导出 Markdown 阅读笔记 |

PDF / EPUB 首版编辑范围为高亮、批注和笔记。不提供 PDF 正文重排、OCR、EPUB 正文改写或 DRM 绕过。扫描 PDF 能否选中文字取决于文件是否已有文字层。

## 1.0.38 安装包

本轮 macOS Apple Silicon（M1 / M2 / M3 / M4 等）安装包验收完成后放在：

`release/current/Guanyi-Reader-1.0.38-mac-arm64.dmg`

GitHub Releases：[发行页面](https://github.com/kaituotuo/Guanyi-MD/releases)。本轮只发布 macOS ARM64；Windows 当前本地产物仍为旧名称的 `1.0.34`，不属于 1.0.38 Release。

从旧名称「观绎 MD」升级：先保存内容并用 **Command+Q** 完全退出旧应用，将「观译阅读器.app」放入“应用程序”，再从“应用程序”打开新名称，检查“关于”显示 **1.0.38**。名称改变后，旧 Dock 图标可能仍指向旧应用，需要固定新应用图标。

应用标识仍为 `com.guanyi.md`，本地数据目录仍为 `guanyi-md`，已有文档、目录、设置和索引继续沿用。请勿删除 `~/Library/Application Support/guanyi-md`。应用改名不会自动删除旧名称的 `.app`。

本次 Mac 包采用 **本地 ad-hoc 签名**，未使用 Apple Developer ID 证书，也未经过 Apple 公证。SHA-256 用于核对下载文件完整性，不代表 Apple 的发行者认证。详细边界见[合规与安全说明](docs/合规与安全说明.md)。

## 本次变化

- 新增 PDF / EPUB 阅读、高亮、批注和笔记，直接复用成熟开源阅读引擎。
- 工具栏随文档格式切换，沿用产品图标。
- 修复分栏模式点击任务列表后跳到文末的问题；光标与两侧滚动位置保持稳定。
- PDF 草稿写入失败时保留当前批注实例；正常关闭会等待保存，避免最后输入丢失。
- 外部 PDF / EPUB 更新后重新打开会创建新的阅读记录，保留旧记录的批注。

## 使用范围与数据

- 文本文件支持 `.md`、`.markdown`、`.txt`，单份不超过 20 MB；PDF / EPUB 单份不超过 100 MB。
- 目录扫描默认最多 5 层，只扫描 Markdown / TXT；全库关键词和语义搜索也面向这些文本格式。
- Markdown 支持图片、表格、任务列表、50 步撤销、批注伴随文件、明暗主题和多页签。
- 本地搜索使用随应用提供的 `bge-small-zh-v1.5` INT8 ONNX 模型与 Meilisearch；索引与查询运行在本机。
- AI 辅助阅读须主动触发，使用配置的服务提供商。生成辅助阅读可能发送当前 Markdown 全文；问作品会发送问题、上下文和选取的原文证据。请先确认内容适合发送给该服务。
- API Key 默认只在当前会话保存；选择“记住”后存入本地浏览器存储，并非 macOS Keychain。
- EPUB 笔记保存在应用资料中，建议定期导出 Markdown；PDF 批注通过“另存为”导出。应用内缓存不是独立备份或跨设备同步服务。

[合规、隐私、安全与证书说明](docs/合规与安全说明.md)记录实际边界和第三方许可；[第三方资源目录](vendor/README.md)保留依赖来源与许可证。项目主代码目前未授予通用开源许可，第三方组件分别适用其自身许可证。

## 开发与构建

```bash
npm install
npm run desktop
```

浏览器开发可运行 `node tools/dev-server.mjs --port 9929`，然后访问 `http://127.0.0.1:9929/`。浏览器端能力受文件权限与存储限制；PDF / EPUB 使用 `vendor/` 离线资源，不能只分发 `index.html`。

```bash
node tools/sync-single-file.mjs
npm run test:regression:all
npm run build:mac
```

`js/app.js`、`css/app.css` 与阅读模块为可维护源码；同步工具将其和 `js/docs-data.js` 内置文档写入 `index.html`。桌面主进程与系统集成位于 `desktop/`，PDF.js、epub.js、JSZip 及许可证位于 `vendor/`。

构建使用项目内 `.cache/`；`build:*` 不改变版本号。正式发布须升级版本、完成完整回归并从干净提交构建，规范见[工程治理与桌面发布闸门](docs/工程治理与桌面发布闸门.md)。

安装包位于 `release/current/`，历史产物位于 `release/archive/`，构建验收位于 `release/build/`；这些目录不提交到 Git。
