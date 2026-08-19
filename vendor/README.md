# 本地浏览器依赖

这些脚本随 Demo 一起保存，`index.html` 在 `file://` 下运行时不访问 CDN。

| 文件 | 版本 | 上游发布包 | 许可证 | SHA-256 |
|---|---:|---|---|---|
| `marked.min.js` | 18.0.9 | npm `marked@18.0.9` 的 `lib/marked.umd.js`，使用 Terser 压缩 | MIT | `638cc936c7aa8e00af240a88d6fd3a8ceb2289d89f542893c1108721cce5d00a` |
| `turndown.min.js` | 7.2.4 | npm `turndown@7.2.4` 的 `dist/turndown.js`，使用 Terser 压缩 | MIT | `372f8f37364d08b17b53e08ec8a5bd1b1d52352274312aeb8cda85227a8c9908` |
| `html2canvas.min.js` | 1.4.1 | npm `html2canvas@1.4.1` 的官方 `dist/html2canvas.min.js` | MIT | `e87e550794322e574a1fda0c1549a3c70dae5a93d9113417a429016838eab8cb` |
| `jspdf.umd.min.js` | 4.2.1 | npm `jspdf@4.2.1` 的官方 `dist/jspdf.umd.min.js` | MIT | `e6551fcdc32f09d6853b2c5126d18d01d9447e0da618a41a11ebeee0f6c20d54` |

来源：

- https://www.npmjs.com/package/marked
- https://www.npmjs.com/package/turndown
- https://www.npmjs.com/package/html2canvas
- https://www.npmjs.com/package/jspdf

完整许可证文本见同目录的 `LICENSE-*.txt`。更新依赖时需同步版本、来源与校验值；项目仍不引入 npm 构建流程。
