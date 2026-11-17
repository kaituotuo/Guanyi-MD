# 观译阅读器交互原型

此目录中的既有 HTML 是对应阶段的方案记录，不代表当前产品的统一视觉基线。新原型请先阅读 [设计系统 V1.0](../design-system/README.md)，并参考[可视组件手册](../design-system/index.html)和当前 `css/app.css`。

新原型在页面说明或同名 README 中写明：

1. 目标场景与文件类型（Markdown / TXT / PDF / EPUB）。
2. 依据的设计系统版本，以及相对当前产品的提案和例外。
3. 默认、悬停、选中、键盘焦点、禁用、加载、空态和错误中适用的状态。
4. 明暗主题、桌面窗口和 760px 以下布局。
5. 交互可点击范围及当前尚未实现的能力。

原型推进到正式界面时，同步更新设计系统中的新规则、`css/app.css` 等可维护源码，并通过 `node tools/sync-single-file.mjs` 更新单文件页面。

当前原型：

- [主页 × PDF 智能研读](home-study/README.md) · [打开主页原型](home-study/index.html)
