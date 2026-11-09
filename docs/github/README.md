# 工作流观察

Windows 本机工作流观察工具。独立桌面版 v0.7.5 提供侧边任务条、完整面板、历史回溯和本机文件入口；保留的 Token Monitor 插件版为 v0.5.0。

公开源码使用空连接配置，不附带作者的聊天、项目、技能资源清单或观察历史。首次启动后，在完整面板的“关联”页填写自己的工程和连接，或新建工作流、登记资源。只有配置并可访问的本机来源会被读取。

## 构建和运行

使用 Windows、Node.js 22+ 与 npm。Electron 和打包校验依赖以 package.json 和锁文件为准。

```powershell
npm ci
npm test
npm run build:desktop
```

构建默认使用本项目 `node_modules/electron/dist` 中固定版本的官方 Electron。若已有同版本的官方 Electron 完整运行时，可将环境变量 `WORKFLOW_ELECTRON_DIST` 设置为该运行时目录，再执行构建；目录应包含 `electron.exe`、`version` 和配套文件，版本必须与桌面包记录一致。该覆盖仅指定运行时来源，不修改其所属应用。

构建完成后运行 `desktop-app/v0.7.5/工作流观察.exe`。当前源码布局需要构建时生成安装配置并复制插件模块，不支持直接 `electron desktop` 启动。

桌面程序在 `desktop-app/`，本机用户数据在 `data/desktop-profile/`。退出时等待历史保存；更新前保留整个数据目录。新克隆构建与其他电脑运行的验证状态见 [STATUS.md](STATUS.md)，不要把源码导出视为跨电脑验收通过。

## 使用范围

- 侧边任务条读取配置的本机 Codex 会话；查看近期文字进展、来源和当前可访问的本机产出文件。
- 完整面板支持自定义工作流、项目进度、技能与资源目录、搜索收藏、变化阅读和历史校验。
- 项目可通过工程根目录的 `workflow-progress.json` 提供结构化进度；格式示例见 [插件说明](plugin/README.md)。总量未知时不推算百分比。
- Skills Manager 为可选连接；未安装或未配置时保留其他功能。

读取器仅摘录 assistant 公开进展，不归档推理、工具原文、用户消息和图片。项目报告和公开进展仍可能包含私有内容，运行后生成的 `data/`、`qa/`、`connections/`、导出配置与历史均应留在本机。软件不会自动将这些内容上传到 GitHub。

技术完成、视觉检查和用户验收分开显示。点击入口可请求 Windows 打开原聊天、工程目录或文件；观察器不接管制作任务、不发送聊天消息。

## 浏览器预览与插件

```powershell
npm run preview
npm run preview:stop
```

预览仅监听 `127.0.0.1`，数据位于 `qa/`，与桌面数据分开。也可使用根目录的预览启动和停止脚本。Token Monitor 0.86.x 插件可用 `npm run build` 打包至 `delivery/`；构建拒绝覆盖已有版本。宿主原生安装和 IPC 的验证边界见 STATUS。

## 安全导出源码

```powershell
node tools/export-github.cjs <全新目标目录>
```

工具按明确白名单复制源码与许可证，使用公开空配置和通用说明，替换任务测试中的聊天 UUID。目标必须不存在，并且不能与源码目录互相包含；来源和目标路径中的目录链接会被拒绝。导出文件由 `EXPORT-MANIFEST.json` 的相对路径、大小和 SHA256 记录，清单不包含本机绝对路径；清单自身不计入哈希列表。

`data/`、`qa/`、`connections/`、`delivery/`、`desktop-app/`、本机快捷方式和个人文档不会进入导出。导出副本包含本工具和公开模板，可再次导出。上传前仍需核对实际 Git 暂存清单；`.gitignore` 不会撤销已经跟踪的文件。

Fuse.js 与 Token Monitor 校验源码的来源和许可证见 [第三方说明](plugin/THIRD_PARTY.md) 和 [vendor/NOTICE.md](vendor/NOTICE.md)。
