# PaperQA2 预研究：观译 PDF 智能研读

研究日期：2026-11-10。基准版本：[paper-qa 2026.8.12](https://pypi.org/project/paper-qa/2026.8.12/)（对应 [v2026.08.12](https://github.com/Future-House/paper-qa/releases/tag/v2026.08.12)）。本稿是官方文档与源码审查，**尚未执行模型问答或验证回答质量**，也未接入观译应用。

## 结论

PaperQA2 适合列为观译的 **PDF 证据检索与文档问答后端候选**。它的核心流程是检索文档、排序并概括证据片段、生成带引文的回答；提供 `pqa` CLI 和 Python `Docs` API。它不提供观译需要的 PDF 阅读界面、批注界面或自动知识卡成品。[官方 README](https://github.com/Future-House/paper-qa/blob/v2026.08.12/README.md)

| 观译能力 | PaperQA2 可复用部分 | 观译仍需负责 |
| --- | --- | --- |
| 文档对话 | 单文档检索、证据排序、带引用回答 | 对话状态、选区/章节范围、取消重试、引用核验与页面回跳 |
| 导读 | 可基于检索片段组织回答 | 文档结构、覆盖范围、字段适配及来源核验 |
| 知识卡 | 可为候选卡提供证据 | 候选问题/答案生成、来源校验、编辑确认、复习与导出 |
| PDF 阅读/批注 | 不适用 | 现有 PDF.js 画布、翻页、缩放、高亮和笔记 |

当前观译的 PDF 仍被排除在正文检索/AI 问答之外；已有引用是 Markdown 字符偏移，不能直接用于 PDF。[现有排除逻辑](../../js/app.js)、[PDF 智能研读 PRD](./PRD.md)。

## 最快了解如何使用

官方最短路径是在 Python 3.11+ 的隔离环境安装 `paper-qa`，把**一份公开、允许处理的 PDF**放在单独目录，进入该目录执行 `pqa ask '你的问题'`。[安装、CLI 和 Python API](https://github.com/Future-House/paper-qa/blob/v2026.08.12/README.md)

```bash
python3.11 -m venv /tmp/guanyi-paperqa
/tmp/guanyi-paperqa/bin/python -m pip install 'paper-qa==2026.8.12'
mkdir -p /tmp/guanyi-paperqa-public-sample
cd /tmp/guanyi-paperqa-public-sample
# 在此目录放入一份公开测试 PDF；先配置模型服务的 API Key。
PQA_HOME=/tmp/guanyi-paperqa-cache /tmp/guanyi-paperqa/bin/pqa ask '这份文档的核心结论及依据是什么？'
```

**这条 CLI 路径默认会联网**：上游默认使用 OpenAI 模型与 embedding，也可能查询 Crossref、Semantic Scholar 等文献元数据服务。PDF 的提取内容会依模型配置发送给服务商。不能把上述命令直接用于私密文档或当作观译的正式隐私方案。[默认配置与元数据说明](https://github.com/Future-House/paper-qa/blob/v2026.08.12/README.md)、[解析设置](https://github.com/Future-House/paper-qa/blob/v2026.08.12/src/paperqa/settings.py)

更可控的单文档试验使用 Python API：显式给 `citation` 与 `docname`，关闭自动文献元数据与多模态增强，指定模型，并选择不调用云 embedding 的 `sparse` 检索。下例仍会向所配置的问答模型发送证据文本；`PQA_LLM` 与服务密钥须在隔离试验环境中配置。

```python
import asyncio
import os
from paperqa import Docs, Settings

settings = Settings(
    llm=os.environ["PQA_LLM"],
    summary_llm=os.environ["PQA_LLM"],
    embedding="sparse",
    parsing={"use_doc_details": False, "multimodal": False},
)

async def main():
    docs = Docs()
    await docs.aadd(
        "/path/to/public-sample.pdf",
        citation="公开测试文档",
        docname="public-sample",
        settings=settings,
    )
    result = await docs.aquery("作者的主要论点由哪些原文支持？", settings=settings)
    print(result.answer)
    for context in result.contexts:
        print(context.text.name, context.text.text)

asyncio.run(main())
```

该示例依据 [Docs.aadd / aquery 源码](https://github.com/Future-House/paper-qa/blob/v2026.08.12/src/paperqa/docs.py) 与 [设置源码](https://github.com/Future-House/paper-qa/blob/v2026.08.12/src/paperqa/settings.py) 编写，**尚未在本机执行**。本机默认 `python3` 是 3.8.9，需另外准备 3.11+ 才能试运行。

## 观译的接入方式

建议先用隔离 Python 工作进程试验，不替换 PDF.js。观译逐页抽取文本，给每个证据块记录 `source_hash / page / block_id / rect / 原文`；把已分块文本送入 [`Docs.aadd_texts`](https://github.com/Future-House/paper-qa/blob/v2026.08.12/src/paperqa/docs.py)，将返回的 `PQASession.answer / contexts` 映射到“文档对话”。点击来源时先核验本地原文与文件版本，再回到 PDF 页和文字区域。[Text、Context、PQASession 结构](https://github.com/Future-House/paper-qa/blob/v2026.08.12/src/paperqa/types.py)

这一方案能复用 PaperQA2 的问答流程，也能让观译控制来源标识和文档范围。上游默认 PDF 分块只以 `pages X-Y` 标识页码范围，不提供供 PDF.js 直接高亮的精确坐标；观译须保留自己的页内映射。[PDF 分块源码](https://github.com/Future-House/paper-qa/blob/v2026.08.12/src/paperqa/readers.py)

首版“知识卡”仍按 PRD：自动提供少量有来源的候选，读者预览、编辑并确认后入库。PaperQA2 的证据可作为候选生成依据，但它本身没有这条完整产品流程。

## 必须先验证的约束

1. **大文件与内存**：观译允许打开 1024 MB PDF，只代表阅读上限。PaperQA2 的 `Docs.aadd(path)` 先用 [`Path.read_bytes()`](https://github.com/Future-House/paper-qa/blob/v2026.08.12/src/paperqa/utils.py) 计算哈希，可能一次读取整个文件；不能直接拿 1024 MB 文件做全文 `aadd`。产品试验应优先测试按页、按范围的 `aadd_texts`，并测内存峰值、索引耗时与取消恢复。
2. **数据外发**：模型、embedding、元数据查询和图表增强是不同的外联路径。试验先关闭自动元数据与多模态增强，明确模型目的地和发送范围，抓取实际外联请求；本地模型也要验证答案质量。只打开文件或翻页不能触发问答外发。[上游设置](https://github.com/Future-House/paper-qa/blob/v2026.08.12/src/paperqa/settings.py)
3. **引用可信度**：带页码不等于该页真正支持每条结论。须检查原文片段、页码和回答之间的支持关系，并测试“文中没有答案”的问题。表格、扫描件、双栏、中文教材与英文论文分别记录失败模式。
4. **桌面分发**：观译目前是 Electron/JS 包，没有 Python 运行时。完整集成会新增 Python 3.11+、依赖与工作进程管理，需测安装包体积、启动时间、签名、崩溃恢复。上游按 CalVer 发布，并说明跨版本兼容不保证，应锁定并回归固定版本。[依赖和版本要求](https://github.com/Future-House/paper-qa/blob/v2026.08.12/pyproject.toml)、[版本说明](https://github.com/Future-House/paper-qa/blob/v2026.08.12/README.md)
5. **分发许可**：主包是 Apache-2.0；可选 `paper-qa-pymupdf` 标 AGPLv3，试验阶段先使用基础解析器，正式分发前逐项核对实际依赖与资源的许可。[主包许可](https://github.com/Future-House/paper-qa/blob/v2026.08.12/LICENSE)、[PyMuPDF 适配包许可](https://github.com/Future-House/paper-qa/blob/v2026.08.12/packages/paper-qa-pymupdf/LICENSE)

## 建议的验证次序

1. 在独立 Python 3.11+ 环境以一份公开中文 PDF 跑通 `Docs.aquery`，记录答案、`contexts`、每次请求、时间与内存；不接观译界面。
2. 以观译 PDF.js 抽取的分页块试 `Docs.aadd_texts`，验证同一句证据能从回答回到正确页与段落；比较 PaperQA 自带 PDF 解析与观译抽取的阅读顺序。
3. 加入公开英文论文及不同学科样本，按 PRD 的证据质量门槛评估准确度、证据不足回答、费用与延迟，再决定是否打包 Python 工作进程。

通过前两步只证明技术连通；达到正式应用的质量和隐私门槛后，才能决定将其列为默认或可选研读后端。
