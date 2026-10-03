# 素材来源与致谢（Credits）

> **本项目的绝大部分美术资产都不是我做的**，它们来自上游开源项目 **dsh-pet**。
> 请务必阅读本节再分发或二次创作。

## 一、上游项目（本仓库的基础）

| 项 | 内容 |
|---|---|
| 仓库 | [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) |
| 作者 | **PC2005-cloud** |
| 本仓库快照 | commit [`51041a7e`](https://github.com/PC2005-cloud/dsh-pet/commit/51041a7eb78e4b8e1df5c0a1dc4576ea481f8920)（2026-10-02），对应 v0.3.1 |
| 许可 | 代码 MIT；素材允许开源使用、**禁止商用** |

### 二创约定（原文照录）

> **二次创作（二创）约定**：基于本项目的衍生 / 改版 / 换皮作品，在**任何介绍、展示、分发该作品的地方**，须附上原作者 GitHub 地址：<https://github.com/PC2005-cloud/dsh-pet>

本仓库已履行该约定：README 顶部「来源」区块、`LICENSE`、本文件与 `PROVENANCE.md`
四处均可找到原作者地址。

## 二、随仓库一起分发的上游素材

以下文件**原样复制自上游**，未做任何修改，版权归 PC2005-cloud，非商用：

| 位置 | 内容 | 说明 |
|---|---|---|
| `dsh-pet/assets/webm/` | **106 段 `.webm` 动画** | 宠物的全部动作（待机 / 点击回应 / 余额分档 / 吃播 / 时节 …），透明通道视频 |
| `dsh-pet/assets/memes/` | 表情包 PNG | 「碎碎念」配图 |
| `dsh-pet/assets/pic/` | 图片资源 | 昵称 / 界面用图 |
| `dsh-pet/assets/fonts/` | 上首软糖体等字体 | 界面字体。**注意：字体有自己的授权，商用前请自行确认** |
| `dsh-pet/assets/config.jsonc` | 默认配置 | 台词池、动画池、物理参数等 |
| `dsh-pet/assets/logo.png` | 应用图标源图 | 托盘 / 快捷方式图标由它生成 |
| `assets/demo/*.gif` | 4 张演示动图 | 从上游 `assets/preview/`（共 106 张）中挑选，仅用于本 README 展示 |
| `docs/upstream/screenshots/` | 8 张运行截图 | 上游 README 的截图，仅作溯源归档 |

## 三、本项目**原创**的部分

| 内容 | 说明 |
|---|---|
| `standalone/` 全部代码 | 桌面外壳、本地服务、三个运行期补丁、设置窗口 |
| `standalone/sound/*.mp3` | **4 枚点击音效，由本项目原创合成** —— 生成脚本见 `scripts/make-sounds.py`（纯 Python 标准库 + ffmpeg 转码）。不包含任何来自第三方产品的音频资产，可随本项目自由使用 |
| `assets/demo/` 之外的 README 文案 | —— |

> 音效合成脚本 `scripts/make-sounds.py` 一并放在仓库里，任何人都可以复现或改造这
> 4 枚音效（改音高、改衰减、换成自己的音色），不依赖任何外部素材库。

## 四、运行时依赖（不随仓库分发）

| 组件 | 版本 | 许可 | 获取方式 |
|---|---|---|---|
| Electron | **43.3.0** | MIT | 首次启动由 `启动桌宠.cmd` 自动从 npmmirror 下载到 `electron/` |
| Node.js | 随 Electron 内置 | MIT | 同上 |
| Chromium | 随 Electron 内置 | BSD 等 | 同上 |

上游 `dsh-pet/` 里还带有 `package.json` / `pnpm-lock.yaml` 等构建清单，
其中列出的第三方 npm 依赖**均未随仓库分发**（`node_modules/` 已在 `.gitignore` 中排除），
仅在你要自行构建上游插件时才需要 `npm install`。

## 五、免责

本项目与 DeepSeek 官方**没有隶属关系**，也不是 DeepSeek 官方产品。
「余额查询」调用的是 DeepSeek 开放平台对外公开的 API
（<https://api.deepseek.com/user/balance>），使用的是你自己的 API Key。

若你是上述任一素材的权利人并认为本仓库的使用方式不妥，请开 issue 联系，我会立即处理。
