# 🖼️ 网盘二维码解析 - 一键直链（Chrome 扩展）

解析 [gamers520.com](https://gamers520.com) 资源页上的网盘二维码（如 `https://gamers520.com/40480.html`），自动提取出二维码背后的真实链接，并在二维码下方注入**可直接点击访问的直链按钮**。

## ✨ 功能

- ✅ **真实图像解码**：用 [jsQR](https://github.com/cozmo/jsQR) 在浏览器本地对二维码图片做像素级解码（`vendor/jsQR.js`，无任何外部请求），得到链接。
- ✅ **data 参数兜底**：本站二维码由 `api.qrserver.com/v1/create-qr-code/?data=...` 动态生成，可直接解析 `data` 参数的 URL 解码结果，无需解码图片，两条通道互为保险。
- ✅ **自动提取提取码**：百度/夸克/迅雷等网盘链接的 `pwd` 提取码会被识别（页面上的"提取码: xxx"），并自动拼接到链接上（`?pwd=xxx`），点击即可直达。
- ✅ **一键复制**：提取码可点击复制到剪贴板。
- ✅ **懒加载适配**：页面图片懒加载 + AJAX 注入内容也能自动处理（`MutationObserver` 监听）。

## 📦 安装（加载已解压的扩展程序）

1. 打开 Chrome，地址栏输入 `chrome://extensions/` 回车。
2. 右上角打开 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择本项目目录 `qc-coder`（包含 `manifest.json` 的那个文件夹）。
4. 打开任意资源页，如 `https://gamers520.com/40480.html`，二维码下方即出现对应网盘的访问按钮。

> 若安装后页面无变化，请刷新页面或确认扩展已启用。

## 🧩 目录结构

```
qc-coder/
├── manifest.json      # MV3 清单（content script 注入配置）
├── content.js         # 核心逻辑：扫描 → 解码 → 注入直链
├── content.css        # 注入面板样式
├── vendor/
│   └── jsQR.js        # jsQR 1.4.0 压缩版（terser -c passes=2 -m，本地，无外网依赖）
└── icons/
    ├── icon16.png / icon48.png / icon128.png   # 扩展图标
    └── *.svg                                    # 各网盘按钮图标
```

## 🔍 二维码解析流程

1. 扫描页面中所有 `<img>`，通过 `src` / `data-src`（含 `qrserver`/`qr`）、`alt`（含"二维码/扫码"）、容器 class 识别二维码图片。
2. **通道 B（优先）**：解析 `api.qrserver.com/...&data=...` 的 `data` 参数，无需解码图片；懒加载图片会同时检查 `data-src`。
3. **通道 A**：通道 B 不可用时，把图片画进 `<canvas>`，调用 `jsQR` 做真实图像解码。二维码内容可以是纯链接，也可以是"链接 + 提取码"的文本。
4. 都失败时，回退到同一卡片内的网盘链接与"提取码: xxx"文本；用 `URL` API 规范化链接并拼接 `?pwd=`（保留已有参数和 `#` 片段）。
5. 在二维码卡片内注入与页面风格一致的访问按钮；提取码会合并为一个可点击复制的紧凑操作区。

## ⚠️ 说明

- 扩展只在 `gamers520.com`（含子域名）页面生效（`manifest.json` 的 `matches` 已限定）。
- jsQR 解码依赖图片可绘制到 canvas（CORS）：本站二维码图片来自 `api.qrserver.com`（允许匿名跨域），可正常解码；若不支持跨域，自动走通道 B（data 参数），不影响结果。
- 若页面结构后续变动导致识别不到，可在 issue 中反馈。