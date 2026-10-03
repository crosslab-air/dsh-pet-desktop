# 参与贡献（Contributing）

感谢愿意帮忙。这个项目的结构比较特殊，动手前请先读 **`PROVENANCE.md`**，
尤其是"许可边界"一节 —— **上游素材禁止商用**，提交素材类改动前请三思。

## 一、最重要的一条原则：上游零改动

`dsh-pet/` 目录是上游代码的**原样快照**，请**不要直接修改里面的文件**。

想加功能 / 改行为，都在 `standalone/` 这一层做，手段有三种：

| 手段 | 位置 | 适用场景 |
|---|---|---|
| 包装 + 注入 | `standalone/electron-main.cjs` | 需要在页面加载时补一段脚本（新增 `patch-*.js` 后记得加进 `PATCH_FILES`） |
| 运行期补丁 | `standalone/patch-*.js` | 接管 / 追加页面行为，原则是"**只包一层，失败静默降级**" |
| 本地服务 | `standalone/server.mjs` | 需要新的 HTTP 端点（宿主契约的复刻与扩展） |

提交前请自检：`dsh-pet/` 下**没有任何文件的 mtime 或内容发生变化**。

## 二、本地跑起来

```powershell
# 首次：下载 Electron 运行时（约 300MB，走 npmmirror）
.\启动桌宠.cmd

# 之后：直接双击桌面快捷方式即可（托盘菜单可创建）
```

调试时的两个入口：

- `启动桌宠.cmd` 是**备用**入口；正常用快捷方式（无控制台窗口）。
- 想看运行日志：托盘菜单 →「查看日志」，或直接看 `data/app.log`。
- 想改配置：`standalone/config.jsonc`（JSONC，可写注释），改完从托盘菜单重启。

## 三、想调前端表现（补丁）

`standalone/patch-*.js` 是**纯运行时注入**的脚本，改动**必须重启桌宠**才生效。
调试建议：给页面开远程调试端口后直读运行时状态，比看日志可靠
（页面里的 `console.log` 不一定会被转发进 `data/app.log`）。

## 四、想改音效

`standalone/sound/*.mp3` 由 `scripts/make-sounds.py` 生成：

```bash
python scripts/make-sounds.py <输出目录>     # 生成 4 个 WAV
ffmpeg -i duck-press.wav -codec:a libmp3lame -b:a 128k duck-press.mp3
```

改完脚本请**同时提交重新生成的 mp3**，保证"脚本能复现仓库里的文件"。

> ⚠️ 请不要提交从其他软件里提取的音频素材 —— 本项目音效坚持原创合成，
> 就是为了让仓库在版权上是干净的。

## 五、提交规范

- 一次提交只做一件事；信息写清"改了什么、为什么"。
- 涉及行为变更的，请说明**怎么验证的**（GUI 类改动尤其重要）。
- 不要提交 `credential.json`、`data/`、`userdata/`、`electron/`、`node_modules/`
  —— 它们已在 `.gitignore` 中，提交前 `git status` 扫一眼。

## 六、Issue / PR 里请带上

- 系统版本、是否全新克隆
- `data/app.log` 里相关片段
- 复现步骤（越短越好）
