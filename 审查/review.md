# Three Workflow Monitor 深度评审

## 总体结论

**建议继续迭代并保留现有技术路线，但当前版本只适合受控试用，尚不足以作为可信、易分发的稳定产品。** 最先要解决的不是再增加功能，而是两条基本承诺：观察到的任务状态必须真实；用户成功保存的配置必须能重开。本次确认 **2 项 P1、8 项 P2、3 项 P3**。P1 是优先修复的核心可靠性缺陷；P2 是可达的功能/交互/交付问题；P3 是局部体验、维护与容量优化。未发现有充分证据支持的 P0，也未证实可由普通项目文本或远程网页触发的高危注入链。

项目已经具备实质工程基础：只读读取公开进展、线程身份与路径核对、不可随意覆盖的历史、未知总量不虚构百分比，以及技术完成与用户验收的区分。Electron 渲染隔离、IPC 来源核验和预览服务边界也不是空白。当前最值得投入的是让这些已有设计组成连续可靠的用户闭环。

### 范围与证据

- 评审对象：Windows 本机工作流观察器；桌面版 0.7.5，保留的 Token Monitor 插件版 0.5.0。
- 基准提交：`505459bdf5d292750ecb1c43edf9e2247b1087d4`，审查日期 2026-11-09。范围包括 plugin、desktop、tools、现有 tests、依赖锁文件与分发文档；未展开审计所有第三方压缩代码的全部内部实现。
- 原始测试 **56/56 通过**。这证明现有用例满足，不代表其外场景无缺陷；已用真实模块补充复现下列具体问题。
- `npm audit --package-lock-only --ignore-scripts --json` 返回 **0 个已知漏洞**，13 个依赖条目。它不等于对捆绑的 Chromium 或全部随库源码作了完整安全证明。
- 建议补丁在隔离副本运行原有测试 **56/56 通过**；另有配置上限、缓存清空、草稿保存、导航顺序及打包/端口场景的针对性验证。顺序读取器示例有 **3/3 独立测试**。
- 环境为 Linux / Node 24.22.1，前端逻辑使用 JSDOM 和真实模块/受控 bridge。尚未完成真实浏览器视觉和 Windows 原生窗口、安装、托盘与多屏交互验收。

### 当前运行链路

本机 Codex JSONL、项目 `workflow-progress.json` 和已配置目录 → 读取器/目录发现 → 任务与流程解释 → 后端串行队列和历史记录 → IPC → 完整面板与侧边任务条。完整面板与侧边条拥有部分独立的读取、状态和历史逻辑；两种呈现值得保留，任务状态的解释应逐步共用。

## 分级问题总览

| 严重度 | 问题 | 分类 | 验证状态 |
|---|---|---|---|
| P1 | [F01 · 增量读取跳过新回合事件，正在执行的任务被隐藏](#f01) | 正确性 | 已复现；提供独立读取器与测试，未集成到建议补丁 |
| P1 | [F02 · 合法配置保存成功，重启却被读取上限拒绝](#f02) | 正确性 | 已复现；建议补丁包含预防修复，针对性回归通过 |
| P2 | [F03 · 构建返回成功，但输出目录可以没有 EXE](#f03) | 正确性 / 发布 | 已复现；建议补丁包含修复，隔离构建回归通过 |
| P2 | [F04 · 编辑流程环节顺序会改变旧阶段 ID 的含义](#f04) | 正确性 / 可维护性 | 已复现；提供方案与示例，需要编辑器和契约联动 |
| P2 | [F05 · 一个进度文件的异常字段使全部项目停止更新](#f05) | 正确性 | 已复现；提供来源边界修复方案，未合入建议补丁 |
| P2 | [F06 · 切换会话目录后旧任务一直留在当前列表](#f06) | 正确性 | 已复现；提供运行中来源切换修复示例 |
| P2 | [F07 · 旧快照响应覆盖用户后来的导航选择](#f07) | 并发 / 异步 | 已用 DOM 事件逻辑复现；建议补丁包含修复，3 场景回归通过 |
| P2 | [F08 · 清空 Skills Manager 配置后又显示旧连接](#f08) | 正确性 | 已复现；建议补丁包含修复，回归通过 |
| P2 | [F09 · 全量重绘丢失设置草稿和历史阅读位置](#f09) | 正确性 / 交互 | 草稿丢失已复现；滚动为静态证实；建议补丁包含两项修复 |
| P2 | [F10 · 停止后的预览强制重用已被占用的端口](#f10) | 正确性 / 可用性 | 已复现；建议补丁包含修复，隔离启动回归通过 |
| P3 | [F11 · 历史详情没有标明产物入口来自当前文件](#f11) | 产品 / 可追溯性 | 静态证实；提供文案与信息分区建议 |
| P3 | [F12 · 收藏和最近访问触发无关的整份搜索索引重建](#f12) | 性能 | 静态依赖分析 + 合成基准；属于有条件的性能优化 |
| P3 | [F13 · 恢复说明菜单指向没有交付的文档](#f13) | 可维护性 / 交付 | 静态证实；建议补丁修复托盘入口，第三方说明需补充整理 |

<a id="f01"></a>

## P1 · F01 · 增量读取跳过新回合事件，正在执行的任务被隐藏

**位置：** [plugin/tasks.cjs:81；desktop/recent-task-feed.cjs:53](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/plugin/tasks.cjs#L81)。

**影响：** 新回合可能持续被当成 completed，侧边条不显示它；这直接破坏观察器最核心的状态可信度。

**触发条件：** 先读到旧回合完成，再在两次轮询间写入 task_started、公开进展及超过 2 MiB 的工具或图片记录。

**证据：** 真实 TaskFeed/RecentTaskFeed 最小复现：追加 3 MiB 工具行后，状态仍为 completed、新进展漏读、show=false；后续小进展恢复显示也不能纠正状态。

**具体改法：** 内存上限与消费完整性分开。始终从已提交游标顺序消费，分块读取并跳过超长单行；游标只提交到完整换行。首次大量补读可分批并显示正在追赶，不能直接跳到末尾且仍声称状态确定。

```js
const {readJsonlDelta} = require('./bounded-jsonl-reader.cjs');
 // 集成位置：TaskFeed.read，保留已有的来源身份核验。
 if (stat.size !== state.size || stat.mtimeMs !== state.mtime) {
   const delta = await readJsonlDelta(handle,
     {offset: state.offset, end: stat.size},
     record => consume(state, record));
   state.offset = delta.offset;
   state.size = stat.size;
   state.mtime = stat.mtimeMs;
 }
```

**修复验收：** 大工具行前后生命周期均被消费；不完整 UTF-8 行下一次继续；新回合不会沿用旧 completed 状态；界面明确补读状态。

**交付状态：** 已复现；提供独立读取器与测试，未集成到建议补丁。完整示例见 examples/bounded-jsonl-reader.cjs，3 项独立测试通过。集成前还须在来源适配入口保留坏记录隔离、明确初次追赶的 I/O 预算，并把新文件加入 plugin/manifest.json 的 files；示例的正确性不等于集成已完成。

<a id="f02"></a>

## P1 · F02 · 合法配置保存成功，重启却被读取上限拒绝

**位置：** [plugin/workspace.cjs:10；plugin/workspace.cjs:23](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/plugin/workspace.cjs#L10)。

**影响：** 重启后工作流和资源界面退回空状态并禁止继续保存。原文件尚在，但用户不能通过正常界面继续使用配置。

**触发条件：** 工作区累计超过 512 KiB。单项资源允许较长中文说明和提示词，80 项数量上限并不能保证总字节量在读取上限内。

**证据：** 60 个通过真实 validateResource 的合法资源成功写入 701,604 字节；重新 init 后 error 非空、resources.length=0。

**具体改法：** 读写共用一个字节上限。在序列化之后、写历史和临时文件之前用 Buffer.byteLength 检查；拒绝超限保存并保留上次可读配置。已存在的超限文件需显式缩减/迁移，补丁不会自动修复它。

```js
const MAX_WORKSPACE_BYTES = 512 * 1024;
 // init：bytes 为 Buffer。
 if (bytes.length > MAX_WORKSPACE_BYTES) throw new Error('配置超过容量');
 // save：serialized 为待写入 JSON 字符串，放在任何写操作之前。
 const serialized = JSON.stringify({...contents, hash}, null, 2);
 if (Buffer.byteLength(serialized, 'utf8') > MAX_WORKSPACE_BYTES) {
   throw new Error('工作区配置超过 512 KiB，请缩短说明或提示词后重试');
 }
 // 通过后继续现有归档和原子替换。
```

**修复验收：** 先成功保存一项，再尝试超限内容：应拒绝第二次保存，不生成额外历史，重启仍能读到第一项。

**交付状态：** 已复现；建议补丁包含预防修复，针对性回归通过。

<a id="f03"></a>

## P2 · F03 · 构建返回成功，但输出目录可以没有 EXE

**位置：** [tools/build-desktop.cjs:62；tools/build-desktop.cjs:94](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/tools/build-desktop.cjs#L62)。

**影响：** 生成成功收据和程序路径，却交付无法启动的目录；目标运行时与收据还可能不一致。

**触发条件：** 先前运行时复制中断，留下 desktop-app/v0.7.5 空目录或不完整目录，再运行构建。

**证据：** 隔离的非执行假运行时复现：构建退出码 0，收据存在，目标 EXE 与 DLL 均不存在。只验证构建控制流，不代表 Windows 原生运行。

**具体改法：** 构建时复制完整固定版本运行时，收据读取实际交付的 EXE。既有目录不能作为完整性判据；保留已有运行中版本检查。

```js
const runtimeCopied = true;
 await fs.mkdir(appRoot, {recursive: true});
 for (const name of await fs.readdir(runtime)) {
   const dest = name === 'electron.exe' ? '工作流观察.exe' : name;
   await fs.cp(path.join(runtime, name), path.join(appRoot, dest),
     {recursive: true, force: true});
 }
 const executable = path.join(appRoot, '工作流观察.exe');
 const exeSha256 = hash(await fs.readFile(executable));
```

**修复验收：** 空目标重建后 EXE/DLL 存在；收据来自目标二进制。实际发布前在 Windows 新用户环境启动。

**交付状态：** 已复现；建议补丁包含修复，隔离构建回归通过。

<a id="f04"></a>

## P2 · F04 · 编辑流程环节顺序会改变旧阶段 ID 的含义

**位置：** [plugin/workflows.cjs:21；plugin/workflows-ui.mjs:23](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/plugin/workflows.cjs#L21)。

**影响：** 旧进度文件里的渲染任务被静默归入另一个环节，任务计数与阶段解释都错误。

**触发条件：** 原“准备、渲染”中 step-2 表示渲染；插入“检查”后按下标重新编号，使 step-2 变成检查。

**证据：** 真实 validateWorkflow 编辑后再 collect：标题为渲染任务的记录被标为“环节：检查”。

**具体改法：** 让 ID 表示身份，数组表示顺序。编辑器保留 {id,label}，移动与改名不改 ID，新增阶段分配新 ID。旧 step-N 保留，不重写历史；后端与编辑器须成对修改。

```js
// 编辑器保存稳定身份；新行没有 id，由后端分配。
 const stages = draft.stages.map(({id, label}) => ({id, label: label.trim()}));
 const previousIds = new Set((previous?.stages || []).map(stage => stage.id));
 const seen = new Set();
 const normalized = stages.map(stage => {
   if (stage.id && !previousIds.has(stage.id)) throw new Error('环节已变化');
   const id = stage.id || `step-${randomUUID()}`;
   if (seen.has(id)) throw new Error('环节不能重复');
   seen.add(id);
   return {id, label: stage.label};
 });
```

**修复验收：** 重排、插入、改名后，旧上报的 stage ID 仍对应同一环节；被删除阶段显示未知/已删除，不能映射到别的阶段。

**交付状态：** 已复现；提供方案与示例，需要编辑器和契约联动。新对象契约须同步把原来的字符串数组校验改为对 stage.label 的类型、长度、非空及控制字符校验，并保留 1–10 项的数量限制。纯标签匹配只能临时兼容旧调用，不能解决改名和重名的身份问题。

<a id="f05"></a>

## P2 · F05 · 一个进度文件的异常字段使全部项目停止更新

**位置：** [plugin/core.cjs:20；plugin/core.cjs:95；plugin/core.cjs:210](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/plugin/core.cjs#L20)。

**影响：** 整个 collect 抛错，后端继续返回上次完整快照；无关健康项目也停止同步。

**触发条件：** JSON 语法正确，但存在 tasks:[null]，或 updatedAt:1e100 这样的超出 Date 范围的数值。

**证据：** 两种输入均调用真实 collect 复现整体拒绝，分别为读取 null.id 和 Invalid time value。

**具体改法：** 在来源入口校验结构和时间范围，并把单一项目解析失败转换成该项目的可见错误。内部已确认类型后不重复校验；采集总入口不要因一张卡片失败放弃全部结果。

```js
// 保留字符串必须带时区的约束，先确认日期可表示。
 function dateValue(value) {
   const millis = typeof value === 'number'
     ? value * 1000
     : typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value)
       ? Date.parse(value) : NaN;
   const date = new Date(millis);
   return Number.isFinite(date.getTime()) ? date.toISOString() : null;
 }

 // 在单个项目的进度解析入口使用，而不是包住全部 collect。
 try {
   const tasks = report.value.tasks ?? [];
   if (!Array.isArray(tasks) || tasks.some(t => !t || typeof t !== 'object' || Array.isArray(t))) {
     throw new Error('tasks 必须是任务对象数组');
   }
   reportStatus(card, report.value, report.source);
   // 继续现有该项目任务归一化逻辑。
 } catch (error) {
   card.state = 'error';
   card.stateLabel = '进度格式需修正';
   card.issues.push(error.message);
 }
```

**修复验收：** 同时配置坏项目 A 和健康项目 B：A 展示具体格式错误，B 仍出现新进展；不静默吞掉错误。

**交付状态：** 已复现；提供来源边界修复方案，未合入建议补丁。示例展示边界位置；现有时间字符串须继续要求时区，不能借修改丢掉这一约束。

<a id="f06"></a>

## P2 · F06 · 切换会话目录后旧任务一直留在当前列表

**位置：** [desktop/active-tasks.cjs:92；desktop/active-tasks.cjs:107](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/desktop/active-tasks.cjs#L92)。

**影响：** 新来源为空仍显示旧来源的进行中任务，且被长期标为来源不可读。

**触发条件：** 观察目录 A 的任务后，把 codexSessionsRoot 改为空目录 B。保留短暂 I/O 故障时任务的逻辑被用于来源更换。

**证据：** 真实 ActiveTasks 连续强制刷新：B 中仍有 A 的一项任务，isOngoing=true、state=unreadable。

**具体改法：** 配置根目录变化时，清理当前来源的候选、任务索引、读取器和产物缓存；同一来源的短暂读取失败继续保留状态。历史保留，并记录来源身份供重启恢复。

```js
// constructor 保存 this.engineRoot = engineRoot。
 const sessionRoot = view.config.codexSessionsRoot;
 if (this.sessionRoot !== undefined && this.sessionRoot !== sessionRoot) {
   this.candidates = [];
   this.byId.clear();
   this.knownIds.clear();
   this.artifactIndexes.clear();
   this.feed = new RecentTaskFeed(this.engineRoot);
   this.lastDirectoryRead = 0;
   this.value = {...this.value, tasks: [], finished: [], live: [], error: null};
 }
 // 继续现有目录扫描；历史按原记录保留。
```

**修复验收：** A→空 B 后当前列表为空；旧快照仍可读；A 的短暂读取失败仍能恢复。跨重启恢复也核对来源身份。

**交付状态：** 已复现；提供运行中来源切换修复示例。

<a id="f07"></a>

## P2 · F07 · 旧快照响应覆盖用户后来的导航选择

**位置：** [desktop/dock.mjs:147；desktop/dock.mjs:88](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/desktop/dock.mjs#L147)。

**影响：** 已切回实时任务，慢返回的历史请求又把界面改回旧快照；连续选快照也可能显示先点的那一份。

**触发条件：** 点击历史快照后，在 dockSnapshot 尚未完成时切回当前任务或再选另一快照。

**证据：** 执行真实 dock.mjs，JSDOM + 可控制 bridge Promise 复现：任务进展被迟到响应改为历史快照；补丁后三种导航顺序均通过。

**具体改法：** 复用已有 historyRequest 作为导航代号。所有新导航使旧请求失效；数据及错误提交前均核对请求和当前模式，保持最后一次选择。

```js
// selectTask 入口使所有历史请求失效。
 ++historyRequest;

 // 历史快照按钮回调。
 const request = ++historyRequest;
 try {
   const snapshot = await bridge.call('dockSnapshot', {id: item.id});
   if (request !== historyRequest || mode !== 'history') return;
   await showSnapshot(snapshot);
 } catch (issue) {
   if (request === historyRequest && mode === 'history') notify(issue.message);
 }
```

**修复验收：** 切实时、连续选两快照倒序返回、重新进入历史列表三种场景均保持用户最后选择。

**交付状态：** 已用 DOM 事件逻辑复现；建议补丁包含修复，3 场景回归通过。

<a id="f08"></a>

## P2 · F08 · 清空 Skills Manager 配置后又显示旧连接

**位置：** [plugin/manager.cjs:14；plugin/manager.cjs:16](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/plugin/manager.cjs#L14)。

**影响：** 界面显示已被用户取消的旧连接及其目录状态，形成当前配置与显示不一致。

**触发条件：** 先成功连接 manager A，再把 managerRoot 清空并连续读取目录。空配置分支返回新对象却不更新缓存。

**证据：** 使用真实 SkillsManager 和注入 CLI runner：初始 connected=true；清空后第一次 false，第二次又 true。

**具体改法：** 未配置也是一个明确的缓存状态，更新 this.value。其余 TTL 和刷新行为可以保留。

```js
if (!managerRoot) {
   this.value = {
     connected: false,
     issue: '未设置 Skills Manager 目录',
     skills: []
   };
   return this.value;
 }
```

**修复验收：** 连接→清空→反复读取保持未连接。切换到新的非空目录仍重新读取。

**交付状态：** 已复现；建议补丁包含修复，回归通过。

<a id="f09"></a>

## P2 · F09 · 全量重绘丢失设置草稿和历史阅读位置

**位置：** [plugin/ui.mjs:201；plugin/ui.mjs:223；plugin/ui.mjs:243](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/plugin/ui.mjs#L201)。

**影响：** 尚未保存的路径被刷新等操作清空；浏览旧历史时列表回到顶部，打断配置和回溯工作。

**触发条件：** 在关联页修改路径后点击刷新或导出；或滚动历史列表后选快照/收到定时更新。

**证据：** 真实 ui.mjs + backend + JSDOM 确认点击刷新后路径变为空；历史列表缺少现有滚动恢复机制要求的 data-scroll-key，控制流静态证实。

**具体改法：** 设置使用独立草稿与开始编辑时的 revision，保存成功或明确放弃时清空；给历史列表添加已有机制识别的稳定滚动标识。无需更换前端框架。

```js
// mount 状态中声明。
 let settingsDraft = null, settingsRevision = null;
 // renderSettings 开头。
 if (settingsDraft === null) {
   settingsDraft = {...latest.config};
   settingsRevision = latest.configRevision;
 }
 input.value = settingsDraft[key] || '';
 input.dataset.focusKey = `settings:${key}`;
 input.addEventListener('input', () => {settingsDraft[key] = input.value;});
 // 提交使用 settingsRevision 和 {...settingsDraft}，成功后才清空。

 // renderHistory 中复用现有滚动恢复。
 list.dataset.scrollKey = 'history:list';
```

**修复验收：** 未保存内容在刷新和失败操作后保留；旧 revision 不被新推送掩盖；历史浏览位置稳定。实际滚动布局仍需浏览器/Windows 验收。

**交付状态：** 草稿丢失已复现；滚动为静态证实；建议补丁包含两项修复。普通 15 秒 receive 通常会避开 settings 模式，所以并非“每 15 秒必丢表单”。工作流和资源编辑器已有 draft，不能把问题扩大到所有表单。

<a id="f10"></a>

## P2 · F10 · 停止后的预览强制重用已被占用的端口

**位置：** [tools/preview-control.cjs:28](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/tools/preview-control.cjs#L28)。

**影响：** 重新启动失败并反复等到超时；用户难以从提示知道是旧端口冲突。

**触发条件：** 正常停止预览后，另一本机服务占用了先前随机端口；启动器仍把旧端口传给新实例。

**证据：** 隔离 HTTP 服务占用端口后，原实现出现 EADDRINUSE 和“预览未就绪”；补丁使用新端口并正常停止。

**具体改法：** 运行中实例继续按身份验证并复用；重新启动的实例让操作系统分配端口 0，成功后回写新 URL。

```js
const existing = await running();
 if (existing) return {record: existing, reused: true};
 // 创建新实例的 args 时：
 args.push('--port', '0');
 // 删除从已停止 previous.url 提取端口的逻辑。
```

**修复验收：** 旧端口占用时仍可启动，原占用服务不受影响，存活的合法实例仍被复用。

**交付状态：** 已复现；建议补丁包含修复，隔离启动回归通过。

<a id="f11"></a>

## P3 · F11 · 历史详情没有标明产物入口来自当前文件

**位置：** [desktop/dock.mjs:114；desktop/dock.mjs:136](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/desktop/dock.mjs#L114)。

**影响：** 旧快照状态旁出现当前日志里的新文件，容易把新文件误认为当时已经存在的成果。

**触发条件：** 进入旧快照中的任务详情，产物读取仍扫描当前聊天日志和文件，并没有快照时间限制。

**证据：** 前后端调用链静态证实。README 已说明文件是“当前可访问”的入口，因此这里是界面时态表达问题，不是原文件或历史被篡改。

**具体改法：** 明确分区：当时状态、当前可访问文件。现在只需准确文案；若以后需要当时产物，快照记录当时引用和出现时间，不能宣称路径能恢复历史文件内容。

```js
fragment.append(element('h2', '', historical
   ? '这条聊天当前可访问的文件'
   : '任务产出'), artifacts);
 if (historical) {
   artifacts.before(element('p', 'hint',
     '以下是当前文件入口，可能晚于这份快照；不代表文件当时的内容。'));
 }
```

**修复验收：** 历史页面清楚标出两种时间，用户不会把当前文件当作该快照的版本证据。

**交付状态：** 静态证实；提供文案与信息分区建议。

<a id="f12"></a>

## P3 · F12 · 收藏和最近访问触发无关的整份搜索索引重建

**位置：** [plugin/quick-ui.mjs:6；plugin/search.mjs:7](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/plugin/quick-ui.mjs#L6)。

**影响：** 大目录下增加无必要的 CPU 工作和输入延迟；小目录目前没有实测严重卡顿。

**触发条件：** workspace.revision 因收藏、最近查看、已读位置变化，但 buildEntries(snapshot,catalog) 根本不依赖 workspace。

**证据：** 原实现合成 CPU 基准：1k/5k/20k 入口构建索引中位 4.37/14.69/59.60 ms；查询中位 4.38/18.53/73.50 ms。Node24/Linux，不含 DOM/IPC/磁盘，不代表用户电脑。

**具体改法：** 先移除与索引输入无关的 revision，保留目录 setter 的显式失效。只有真实数据规模和交互测量证明必要时，再拆静态目录索引与实时任务索引或移到 Worker。

```js
const key = `${snapshot?.id}:${catalog?.fingerprint}:${catalog?.manager?.fingerprint}`;
 if (!index || key !== indexKey) {
   index = new SearchIndex(buildEntries(snapshot, catalog));
   indexKey = key;
 }
 // 收藏/已读状态单独更新，不参与这份索引的失效键。
```

**修复验收：** 只更改收藏/最近访问不重建索引；任务或目录真实变化仍更新结果。

**交付状态：** 静态依赖分析 + 合成基准；属于有条件的性能优化。

<a id="f13"></a>

## P3 · F13 · 恢复说明菜单指向没有交付的文档

**位置：** [desktop/main.cjs:137；plugin/THIRD_PARTY.md:12](https://github.com/d727049154-ux/three-workflow-monitor/blob/505459bdf5d292750ecb1c43edf9e2247b1087d4/desktop/main.cjs#L137)。

**影响：** 用户需要帮助时菜单本身打不开；第三方说明还存在内部文档悬空引用。

**触发条件：** 使用当前公开仓库构建后点击“打开使用与恢复说明”。源码及公开导出白名单中均没有该目标文件。

**证据：** 已比对菜单路径、仓库文件列表与导出白名单。README/STATUS 存在，但 docs/独立桌面版使用与恢复.md 不存在。

**具体改法：** 菜单先指向实际交付的 README；独立恢复文档确有必要时再加入公开文档和导出白名单。第三方说明使用存在的原始来源或写明内容，删除悬空内部路径。

```js
{
   label: '打开使用说明',
   click: () => shell.openPath(path.join(projectRoot, 'README.md'))
     .then(error => { if (error) notifyError(error); })
}
```

**修复验收：** 公开源码构建的帮助入口可打开；第三方来源链接实际存在。

**交付状态：** 静态证实；建议补丁修复托盘入口，第三方说明需补充整理。

## 安全判断：保留已有边界，把精力放到实际缺口

| 方向 | 代码证据 | 本次判断 |
|---|---|---|
| 渲染权限 | `desktop/main.cjs:206`、`desktop/task-dock.cjs`：sandbox/contextIsolation 开启，nodeIntegration 关闭 | 有清晰的进程权限边界 |
| IPC 鉴权 | `desktop/main.cjs:143` 检查 WebContents、主 frame、精确入口 URL；`desktop/contract.cjs` 限制方法与载荷 | 无需给纯本机 UI 再添加账户登录系统 |
| 注入与命令执行 | 文本用 textContent；进程调用为参数数组且 shell:false；线程入口限制 UUID | 本轮未确认由普通聊天文本触发的注入链 |
| 路径边界 | `Reader.read` 与资源打开使用 realpath 和已配置根目录约束 | 用户明确选择的本机目录不能直接算越权漏洞 |
| 浏览器预览 | 仅监听 127.0.0.1；Host、Origin、随机请求 token 和静态文件白名单 | 保留现有边界；F10 是可用性问题 |
| 隐私与导出 | 公开导出白名单、默认空配置、仅摘录公开进展；运行数据在本机 | 本地摘录仍可能有私有内容，导出界面应清楚显示范围；不把它说成已发生泄漏 |
| 依赖 | 锁定 Electron 45.2.1 / semver 7.8.5；实际注册表审计 0 | 未证实具体依赖漏洞；发行时继续跟踪上游安全更新 |

以上判断适用于当前本机界面和已配置来源的信任边界。Electron 官方安全文档见文末来源；45.2.1 的官方页面记录了其 Chromium 156.0.8078.75 与 Node 24.22.1 版本，发行维护应继续跟踪上游安全更新。

## 可维护性与性能的取舍

**维护重点应是稳定身份、清晰状态和恰当职责。** `core.cjs`、`tasks.cjs` 与 UI 中大量几百字符单行把条件分支压在一起，增加来源状态和错误路径的复核成本。修改相关函数时正常格式化并保留现有职责即可，不必为了缩短文件拆大量转发包装。优先修复阶段 ID、来源身份和导航代号这些已经出现问题的契约。

**两个界面共享任务事实，分别负责呈现。** 逐步让会话适配器只输出一份稳定任务记录；完整面板做工作流分组，侧边条做注意力排序。保留本地 worker 和模块化 JS。当前证据没有表明必须重写成 Rust，或引入数据库、事件总线、远程服务才能解决问题。

**先减少无效工作，再优化语言和算法。** F12 是直接可证实的索引失效问题。另有两个容量方向适合在真实目标数据上测量后处理：`backend.cjs:49` 固定间隔往串行队列追加刷新，慢扫描时可将定时刷新合并为最多一个在途请求；`history.cjs:85` 导出先读入全部快照/证据并构造字符串，最后才检查 100 MiB 限制，长期大量历史可先计算容量、按段导出或流式输出。这些是有条件的容量建议，未列为当前已发生卡顿或内存崩溃。

周期任务可复用当前队列，但对重复刷新合并，不阻止用户的配置或 checkpoint：

```js
let pendingRefresh = null;
function scheduleRefresh() {
  if (pendingRefresh) return pendingRefresh;
  pendingRefresh = queue(() => refresh())
    .finally(() => { pendingRefresh = null; });
  return pendingRefresh;
}
const timer = setInterval(() => scheduleRefresh().catch(e => log(e.message)), 15000);
```

只有周期/重复读取适用此合并；不能把不同参数的写操作合并掉。详细产品路线见 [product-plan.md](product-plan.md)，补丁覆盖范围与后续实施见 [implementation-guide.md](implementation-guide.md)。

## 来源

所有代码结论在对应问题处链接到固定提交。外部资料于 2026-11-09 读取，使用一手文档；下面的产品参考支持设计借鉴，不证明本项目已具有那些功能。

- [项目源码（固定提交）](https://github.com/d727049154-ux/three-workflow-monitor/tree/505459bdf5d292750ecb1c43edf9e2247b1087d4)：所有代码事实均对应这一提交，报告中另给精确文件链接。
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)：渲染隔离、IPC 来源、导航与依赖边界。
- [Electron 45.2.1](https://releases.electronjs.org/release/v45.2.1)：核实固定版本及 Chromium/Node 组成，不据版本号臆断 CVE。
- [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/)：注册表已知漏洞审计的范围。
- [ActivityWatch 数据模型](https://docs.activitywatch.net/en/latest/buckets-and-events.html)：来源独立、相同数据的心跳合并。
- [ccusage 官方介绍](https://ccusage.com/guide/)：本地读取、多来源统一输出与可靠性边界。
- [Claude Code hooks 指南](https://code.claude.com/docs/en/hooks-guide)：生命周期与明确的等待输入/权限信号。
- [VS Code Quick Picks](https://code.visualstudio.com/api/ux-guidelines/quick-picks)：名称、说明、上下文与分组检索。
- [VS Code Notifications](https://code.visualstudio.com/api/ux-guidelines/notifications)：仅在必要时打断用户，避免重复提醒。
- [Node 文件系统 API](https://nodejs.org/api/fs.html)：分块读取、文件句柄与持久化语义。
