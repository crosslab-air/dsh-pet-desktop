# 溯源声明（Provenance）

本文件说明**这个仓库是由什么、怎么组合出来的**，以及每部分内容的许可归属。
如果你要二次创作、再分发，或只是想搞清楚"哪段是谁写的"，看这一份就够。

## 一、一句话结构

```
本仓库  =  上游快照（dsh-pet @ 51041a7e）
         +  改造层（standalone/，本项目新增）
         +  文档与构建脚本（README / PROVENANCE / CREDITS / scripts/）
```

上游代码**一行未改**，所有增强都在 `standalone/` 这一层通过"包装 + 运行期注入"实现。

## 二、上游快照

| 项 | 值 |
|---|---|
| 来源仓库 | <https://github.com/PC2005-cloud/dsh-pet> |
| commit | `51041a7eb78e4b8e1df5c0a1dc4576ea481f8920` |
| 提交时间 | 2026-10-02T09:12:59Z |
| 对应版本 | `dsh-pet` package.json `version = 0.3.1`（最新 tag v0.3.1） |
| 许可 | 代码 MIT / 素材允许开源使用、禁止商用 |
| 落地位置 | 本仓库 `dsh-pet/` |

### 为什么 `dsh-pet/` 是"嵌套一层"的目录

上游仓库本身就是这个结构：**仓库根**放文档、提示词、素材处理脚本与 CI，
真正的插件包在**子目录 `dsh-pet/`** 里（`src/` `runtime/` `assets/` `package.json`）。

本仓库的 `dsh-pet/` 直接对应上游的那个子目录，因为改造层的运行期路径是按它写死的：

```js
// standalone/app/main.cjs
const ROOT = path.resolve(STANDALONE_DIR, '..');
const HELPER_DIR = path.join(ROOT, 'dsh-pet', 'runtime', 'electron-helper');
const ICON_SRC   = path.join(ROOT, 'dsh-pet', 'assets', 'logo.png');
// standalone/server.mjs
const PKG = join(ROOT, 'dsh-pet');  const ASSETS = join(PKG, 'assets');
```

所以**目录名 `dsh-pet/` 不能改**，改了要同步改上面这几处。

## 三、逐项对照

### 3.1 原样保留（未做任何修改）

| 上游内容 | 本仓库位置 | 说明 |
|---|---|---|
| `dsh-pet/src/` | `dsh-pet/src/` | 插件 TS 源码（桌面版运行时不加载，保留供溯源与自行构建） |
| `dsh-pet/runtime/` | `dsh-pet/runtime/` | **桌面版运行期的核心依赖**（`electron-helper/` 里的 Electron 壳、`sprite.js` 动画链、`shared-core.js` 共享逻辑） |
| `dsh-pet/assets/` | `dsh-pet/assets/` | 106 段 webm、memes、pic、fonts、logo、默认 config.jsonc（**已排除 `preview/`，见 3.3**） |
| `dsh-pet/scripts/` | `dsh-pet/scripts/` | 上游构建脚本 |
| `dsh-pet/package.json` 等 | 同左 | 依赖清单与 TS/ESLint/Prettier 配置 |
| `dsh-pet/README.md`、`LICENSE` | 同左 | 上游原文件，保留以便对照 |

### 3.2 本项目新增

| 内容 | 位置 | 说明 |
|---|---|---|
| 桌面外壳 | `standalone/app/` | `main.cjs`（单进程入口 + 托盘 + 设置窗口）、`settings.html`、`preload-settings.cjs` |
| 本地服务 | `standalone/server.mjs` | 复刻宿主 HTTP 契约（`/config` `/state` `/balance` `/thumb/*` `/pic/*` `/sound/*`），并提供余额查询 |
| 运行期补丁 | `standalone/patch-click-balance.js`<br>`standalone/patch-shell.js`<br>`standalone/patch-sound.js` | 左键点击回应 + 余额气泡 / 右键菜单接管与追加项 / 点击音效 |
| 包装层 | `standalone/electron-main.cjs` | 重定向 `index.html` 加载 + 注入上述补丁；不改上游文件 |
| 配置与密钥 | `standalone/config.jsonc`<br>`standalone/credential.example.json`<br>`standalone/set-key.mjs` | 由上游 `assets/config.jsonc` 派生的独立副本（差异有 5 处，文件内已逐条标注 `[STANDALONE]`） |
| 原创音效 | `standalone/sound/*.mp3` | 4 枚，由 `scripts/make-sounds.py` 合成 |
| 启动脚本 | `启动桌宠.cmd`<br>`设置密钥.cmd`<br>`scripts/ensure-electron.ps1` | 首次运行自动下载 Electron；设置 Key |
| 文档 | `README.md` `LICENSE` `PROVENANCE.md` `CREDITS.md` `CONTRIBUTING.md` `docs/技术说明.md` | —— |

### 3.3 上游有、但**未纳入**本仓库的内容

| 上游内容 | 体积 | 未纳入的原因 |
|---|---|---|
| `dsh-pet/node_modules/` | 149 MB | npm 构建依赖。**运行期不加载**，仅在自行构建上游插件时才需要 |
| `dsh-pet/assets/preview/` | 65 MB | 上游 README 用的 106 张演示 GIF。运行期代码零引用；本仓库只挑了 4 张放进 `assets/demo/` |
| `dsh-pet/lib/` | —— | 上游的构建产物（上游 `.gitignore` 已排除），本机原本就不存在 |
| `video/*.mp4` | —— | 上游素材源视频，托管在 GitHub Releases，本就不入库 |

### 3.4 ⚠️ 一处**必须保留**的上游构建产物

上游 `.gitignore` 里写着：

```gitignore
dsh-pet/lib/
dsh-pet/runtime/electron-helper/shared-core.js
```

也就是说 `shared-core.js` 在**上游**是构建产物、不入库。但它是桌面版运行期的硬依赖
（`PetShared.mountContextMenu` 等都在里面），所以**本仓库必须把它一起提交**，
并且它的字节内容与上游 `scripts/build-desktop-core.mjs` 的产出一致 —— 未做任何修改。

如果你要自行重新生成它：在 `dsh-pet/` 下 `npm install` 后运行 `npm run build:desktop-core`
（对应 `scripts/build-desktop-core.mjs`）。

### 3.5 上游根层的文档与开发工具 → 归档到 `docs/upstream/`

上游仓库**根层**还有一批与"运行桌面版"无关、但有溯源价值的内容。
本仓库没有把它们放在仓库根（避免与自己的 README / scripts 冲突），而是原样归档：

| 上游根层内容 | 本仓库位置 | 说明 |
|---|---|---|
| `README.md`（42 KB） | `docs/upstream/README.md` | 上游原版 README，保留以便对照（仓库根的是本项目自己的 README） |
| `API.md`、`openapi.yaml` | `docs/upstream/` | 上游 DSH 插件的宿主 API 契约文档 |
| `prompts/` | `docs/upstream/prompts/` | 动画生成用的 AI 提示词（属于上游声明的"提示词"类素材） |
| `scripts/` | `docs/upstream/scripts/` | 上游的素材处理链（Python / Swift / shell），产出 webm 与预览 GIF |
| `tools/` | `docs/upstream/tools/` | 上游的 API 调试页与 DPI 探测工具 |
| `assets/screenshots/`（11 MB，8 张） | `docs/upstream/screenshots/` | 上游 README 运行截图 |
| `video/watermark_mask_v5.mkv` | `docs/upstream/video/` | 素材处理链用的遮罩 |
| `.github/workflows/hevc-alpha.yml` | **未纳入** | 上游的 macOS HEVC 转码 CI，与本桌面版无关 |
| `.gitignore` / `.gitattributes` | **未纳入** | 本仓库用自己的一套（见根目录） |

## 四、许可边界（最重要的一节）

| 类别 | 许可 | 能否商用 |
|---|---|---|
| `dsh-pet/` 下的**代码** + `standalone/` 下的代码 | MIT（双版权行见 LICENSE） | ✅ 可以 |
| `standalone/sound/*.mp3`（本项目原创合成） | 随本项目，可自由使用 | ✅ 可以 |
| **上游素材**：`dsh-pet/assets/**`、`assets/demo/*.gif` | 允许开源使用 | ❌ **禁止商用** |
| `dsh-pet/assets/fonts/` 下的字体 | 各自的字体授权，与上游无关 | ⚠️ 商用前请自行确认 |
| Electron / Chromium（不随仓库分发） | MIT / BSD 等 | ✅ 可以 |

二创约定（上游 README 原文）：**任何介绍、展示、分发基于本项目的衍生作品的地方，
须附上原作者地址** <https://github.com/PC2005-cloud/dsh-pet>。

## 五、如何从零复刻本仓库

```bash
# 1) 取上游指定 commit 的源码
curl -L -o dsh-pet.zip \
  https://codeload.github.com/PC2005-cloud/dsh-pet/zip/51041a7eb78e4b8e1df5c0a1dc4576ea481f8920
# 2) 解包，把其中的子目录 dsh-pet/ 放到本仓库根下，并剔除 node_modules 与 assets/preview
# 3) 叠加本仓库的 standalone/ 与启动脚本
# 4) 首次运行 启动桌宠.cmd，自动下载 Electron
```

## 六、版本对应

| 本仓库 | 上游 dsh-pet | 备注 |
|---|---|---|
| v1.0.0 | 51041a7e（v0.3.1） | 首个桌面版发布 |
