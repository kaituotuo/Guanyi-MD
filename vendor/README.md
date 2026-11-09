# 本地浏览器依赖

这些资源随观译阅读器一起分发，阅读引擎和字体不从 CDN 加载。PDF / EPUB 阅读需要保留整个 `vendor/` 目录。

| 文件 | 版本 | 上游发布包 | 许可证 | SHA-256 |
|---|---:|---|---|---|
| `marked.min.js` | 18.0.9 | npm `marked@18.0.9` 的 `lib/marked.umd.js`，使用 Terser 压缩 | MIT | `638cc936c7aa8e00af240a88d6fd3a8ceb2289d89f542893c1108721cce5d00a` |
| `turndown.min.js` | 7.2.4 | npm `turndown@7.2.4` 的 `dist/turndown.js`，使用 Terser 压缩 | MIT | `372f8f37364d08b17b53e08ec8a5bd1b1d52352274312aeb8cda85227a8c9908` |
| `html2canvas.min.js` | 1.4.1 | npm `html2canvas@1.4.1` 的官方 `dist/html2canvas.min.js` | MIT | `e87e550794322e574a1fda0c1549a3c70dae5a93d9113417a429016838eab8cb` |
| `jspdf.umd.min.js` | 4.2.1 | npm `jspdf@4.2.1` 的官方 `dist/jspdf.umd.min.js` | MIT | `e6551fcdc32f09d6853b2c5126d18d01d9447e0da618a41a11ebeee0f6c20d54` |
| `jszip.min.js` | 3.10.2 | npm `jszip@3.10.2` 的官方 `dist/jszip.min.js` | MIT | `7f839b2d4688b845c105ebf5d2f9803075f91ea0fe72bdaac176c3a04dd3d2c1` |
| `epub.min.js` | 0.3.93 | npm `epubjs@0.3.93` 的官方 `dist/epub.min.js` | BSD-2-Clause | `06eae15745107b4aa508c95538275251f69bfb9f1175621fc458d9f42ed082d4` |
| `pdfjs/` | 6.5.438 | Mozilla 官方完整 GENERIC viewer 发行包 | Apache-2.0，附带资源另保留其许可 | 官方 ZIP：`fcbe9ba21d9911843e3502adc178a7f549a524a4055f887bedc942e5490c6ba1` |

来源：

- https://www.npmjs.com/package/marked
- https://www.npmjs.com/package/turndown
- https://www.npmjs.com/package/html2canvas
- https://www.npmjs.com/package/jspdf
- https://www.npmjs.com/package/jszip
- https://github.com/futurepress/epub.js
- https://github.com/mozilla/pdf.js/releases/tag/v6.5.438

完整许可证文本见同目录的 `LICENSE-*.txt` 和 `pdfjs/LICENSE`；PDF 字体、CMaps、WASM 的许可证保留在对应子目录。更新依赖时需同步版本、来源与校验值；桌面打包通过项目 npm 脚本执行。

EPUB.js 的依赖许可证汇总在 `LICENSE-epubjs-dependencies.txt`。阅读器仅在具有原生 `DOMParser` 的浏览器环境运行，书籍脚本、表单和远程资源由集成层限制。
