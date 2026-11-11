# 工作流观察

Windows 本机工作流观察器，基于 Tauri 2 + Rust；运行时使用系统 WebView2，不需要 Node.js。使用与恢复说明以 [HELP.md](src-tauri/HELP.md) 为准，应用内“帮助与恢复”和发行包 README 使用同一份内容。

产品源码位于本目录，仓库流程与票据位于上一层。开发需要 Windows、Rust MSVC 工具链、Visual Studio C++ 构建工具和 Node.js 22.12+：

```powershell
# 在仓库根目录运行
npm --prefix three-workflow-monitor ci
npm --prefix three-workflow-monitor test
npm --prefix three-workflow-monitor run build
```

在本产品目录可直接运行 `npm ci`、`npm test`、`npm run build`。测试入口运行 Rust 全套及 Node 行为测试。构建入口执行真实 `cargo build --locked --release`，校验 Cargo 返回的 Windows 可执行文件，输出 `dist/workflow-monitor/workflow-monitor.exe`，随附使用说明、程序许可和本次构建组件的许可证原文。已存在发行目录若含其他文件或数据，构建会停止并要求先移出，避免覆盖。`CARGO_TARGET_DIR` 可指定 Cargo 缓存目录。

前端文件直接编译进可执行文件，无需另起服务。第三方声明从本机 Cargo 组件许可及 `tools/licenses/` 补充原文生成；补充出处记录在 `tools/licenses/overrides.json`，升级组件时若缺许可证会停止打包。本程序使用 [MIT 许可证](LICENSE)。

发行构建会用 Windows 自带的 `icacls` 将最终 EXE 标记为普通桌面程序的 Medium 完整性，避免继承开发目录的 Low 标记后无法写入 AppData；设置失败则构建失败并清理不完整输出。此步骤只处理发行 EXE。

发行构建与自动检查不代表交互验收；实际接入、原生打开、托盘、退出重开及多屏行为需在 Windows 发行程序上完成手工验证。
