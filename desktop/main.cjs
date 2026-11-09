'use strict';
const {app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, session} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const crypto = require('node:crypto');
const {BackendService} = require('./service.cjs');
const {validateCall, validateCommand} = require('./contract.cjs');
const {fitBounds, compactTransition, readPreferences, writeJson} = require('./window-state.cjs');
const {createShutdown} = require('./shutdown.cjs');
const {TaskDock} = require('./task-dock.cjs');
const version = require('./package.json').version;
const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployment.json'), 'utf8'));
if (deployment.schema !== 'workflow-desktop-deployment/1') throw new Error('安装配置不完整');
const projectRoot = path.resolve(__dirname, deployment.projectRelative);
const userData = path.join(projectRoot, 'data', 'desktop-profile');
const dataDirectory = path.join(userData, 'data');
fs.mkdirSync(userData, {recursive: true});
fs.mkdirSync(path.join(userData, 'browser'), {recursive: true});
app.setName('工作流观察');
app.setAppUserModelId('Local.WorkflowMonitor.Desktop');
app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'browser'));
app.disableHardwareAcceleration();
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) { app.quit(); }
else {
  const instanceId = crypto.randomUUID();
  const preferencesFile = path.join(userData, 'window.json');
  const runtimeFile = path.join(userData, 'runtime.json');
  const entry = path.join(__dirname, 'index.html');
  const entryUrl = pathToFileURL(entry).href;
  const dockUrl = pathToFileURL(path.join(__dirname,'dock.html')).href;
  let window, dock, tray, service, preferences, latest, latestDock, ready = false, quitting = false;
  let preferenceTimer, preferencesWritable = true, startupError = null;
  let pinnedTimer;
  let writes = Promise.resolve();
  const startedAt = new Date().toISOString();
  function log(kind, message) {
    fs.appendFile(path.join(userData, 'desktop.log'), JSON.stringify({at: new Date().toISOString(), kind, message: String(message).slice(0, 1000)}) + '\n', () => {});
  }
  function send(channel,value) {
    const targets=channel==='workflow:data'?[window]:channel==='workflow:dock-data'?[dock?.window]:[window,dock?.window];
    for(const target of targets)if(target&&!target.isDestroyed())target.webContents.send(channel,value);
  }
  function windowState() {
    return {version,compact:preferences?.compact===true,alwaysOnTop:preferences?.alwaysOnTop!==false,mainVisible:window?.isVisible()||false,dock:dock?.state(),dataDirectory,ready};
  }
  function writeRuntime(extra = {}) {
    const record = {schema: 'workflow-desktop-runtime/1', version, pid: process.pid, instanceId, projectRoot, dataDirectory, startedAt,
      updatedAt: new Date().toISOString(), ready, visible: window?.isVisible() || false,
      bounds: window && !window.isDestroyed() ? window.getBounds() : null,
      dock:dock?.state()||null,activeTasks:latestDock?.tasks?.length||0,dockSnapshot:latestDock?.historyId||null,dockCheckedAt:latestDock?.checkedAt||null,dockError:latestDock?.error||null,
      compact: preferences?.compact === true, alwaysOnTop: preferences?.alwaysOnTop !== false,
      snapshot: latest?.snapshot?.id || null, checkedAt: latest?.checkedAt || null, error: startupError || latest?.error || null, ...extra};
    writes = writes.then(() => writeJson(runtimeFile, record)).catch(error => log('runtime-write', error.message));
    return writes;
  }
  function notifyError(message) {startupError = String(message); log('error', message); send('workflow:error', startupError); void writeRuntime();}
  function savePreferences() {
    if (!preferencesWritable) return;
    const value = {schema: 'workflow-desktop-window/1', ...preferences, updatedAt: new Date().toISOString()};
    writes = writes.then(() => writeJson(preferencesFile, value)).catch(error => notifyError(error.message));
  }
  function rememberBounds() {
    if (!window || window.isDestroyed() || window.isMinimized()) return;
    const bounds = window.getBounds();
    preferences.bounds = preferences.compact ? {...preferences.bounds, x: bounds.x, y: bounds.y} : bounds;
    clearTimeout(preferenceTimer);
    preferenceTimer = setTimeout(() => {savePreferences(); void writeRuntime();}, 350);
  }
  function showWindow({reset = false} = {}) {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    const current = window.getBounds();
    const area = reset ? screen.getPrimaryDisplay().workArea : screen.getDisplayMatching(current).workArea;
    const target = fitBounds(reset ? {...current, x: undefined, y: undefined} : current, area, preferences.compact);
    if (['x','y','width','height'].some(key => current[key] !== target[key])) window.setBounds(target);
    preferences.mainVisible=true;window.show();window.moveTop();window.focus();savePreferences();void writeRuntime();
  }
  function hideWindow() {preferences.mainVisible=false;window.hide();savePreferences();void writeRuntime();}
  function dockChanged() {savePreferences();send('workflow:window-state',windowState());updateTray();void writeRuntime();}
  function showDock() {dock?.show();}
  function refresh() {
    if(ready)service.call('refreshAll').catch(error=>notifyError(error.message));
  }
  function applyPinnedWindows() {
    clearInterval(pinnedTimer);
    const pinned = preferences.alwaysOnTop;
    const windows = [window, dock?.window].filter(Boolean);
    for (const target of windows) target.setAlwaysOnTop(pinned, 'screen-saver');
    if (!pinned || process.platform !== 'win32') return;

    function raiseVisibleWindows() {
      const visible = windows.filter(target => !target.isDestroyed() && target.isVisible() && !target.isMinimized());
      // Keep the focused app window above its companion when they overlap.
      visible.sort((a, b) => Number(a.isFocused()) - Number(b.isFocused()));
      for (const target of visible) target.moveTop();
    }
    raiseVisibleWindows();
    pinnedTimer = setInterval(raiseVisibleWindows, 500);
  }
  function setPinned(value) {
    preferences.alwaysOnTop=value;
    applyPinnedWindows();
    savePreferences(); send('workflow:window-state', windowState()); updateTray(); void writeRuntime();
  }
  function setCompact(value) {
    if (preferences.compact === value) return;
    const current = window.getBounds();
    const area = screen.getDisplayMatching(current).workArea;
    const {full, next} = compactTransition(preferences, current, area, value);
    preferences.compact = value; preferences.bounds = full;
    window.setMinimumSize(Math.min(360, area.width), Math.min(value ? 220 : 420, area.height));
    // Compute before changing the minimum size: Windows can emit resize synchronously.
    window.setBounds(next);
    preferences.bounds = value ? {...full, x: next.x, y: next.y} : window.getBounds();
    savePreferences(); send('workflow:window-state', windowState()); updateTray(); void writeRuntime();
  }
  function menuTemplate() {
    return [
      {label: `工作流观察 · 独立版 ${version}`, enabled: false},
      {label: '显示面板', click: showWindow},
      {label:'显示侧边任务条',click:showDock},
      {label:'侧边条位置',submenu:[
        {label:'屏幕左侧',type:'radio',checked:preferences.dock?.side!=='right',click:()=>dock?.setSide('left')},
        {label:'屏幕右侧',type:'radio',checked:preferences.dock?.side==='right',click:()=>dock?.setSide('right')}
      ]},
      {label: '找回窗口（主屏中央）', click: () => showWindow({reset: true})},
      {label: '立即刷新全部', click: refresh, enabled: ready},
      {type: 'separator'},
      {label: '始终置顶', type: 'checkbox', checked: preferences.alwaysOnTop, click: item => setPinned(item.checked)},
      {label: '收起为摘要', type: 'checkbox', checked: preferences.compact, click: item => setCompact(item.checked)},
      {label:'隐藏到托盘',click:()=>{hideWindow();dock?.hide();}},
      {type: 'separator'},
      {label: '打开历史数据目录', click: () => shell.openPath(dataDirectory).then(error => {if (error) notifyError(error);})},
      {label: '打开使用与恢复说明', click: () => shell.openPath(path.join(projectRoot, 'docs', '独立桌面版使用与恢复.md')).then(error => {if (error) notifyError(error);})},
      {type: 'separator'},
      {label: '退出观察', click: () => app.quit()}
    ];
  }
  function updateTray() {if (tray && !tray.isDestroyed()) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));}
  function requireWindow(event) {
    const owner=[{window,url:entryUrl},{window:dock?.window,url:dockUrl}].find(item=>item.window&&!item.window.isDestroyed()&&event.sender===item.window.webContents);
    if(!owner||event.senderFrame!==owner.window.webContents.mainFrame||event.senderFrame.url!==owner.url)throw new Error('窗口来源不匹配');
    return owner.window;
  }
  ipcMain.handle('workflow:call', async (event, input) => {
    try {
      requireWindow(event);
      const {method, args} = validateCall(input);
      const value = await service.call(method, args);
      if (method === 'dockOpenArtifact') {
        if (!value.play) {
          shell.showItemInFolder(value.path);
          return {ok: true};
        }
        const error = await shell.openPath(value.path);
        if (error) throw new Error('无法用系统播放器打开视频');
        return {ok: true};
      }
      return {ok: true, value};
    }
    catch (error) {return {ok: false, error: error.message};}
  });
  ipcMain.handle('workflow:window', async (event, command) => {
    try {
      const senderWindow=requireWindow(event);validateCommand(command);
      if (command === 'pin') setPinned(!preferences.alwaysOnTop);
      if (command === 'compact') setCompact(!preferences.compact);
      if(command==='hide')hideWindow();
      if(command==='dockShow')showDock();
      if(command==='dockHide')dock.hide();
      if(command==='dockExpand')dock.expand(true);
      if(command==='dockCollapse')dock.expand(false);
      if(command==='dockPanel'){dock.expand(false);showWindow();}
      if(command==='dockLeft')dock.setSide('left');
      if(command==='dockRight')dock.setSide('right');
      if(command==='menu')Menu.buildFromTemplate(menuTemplate()).popup({window:senderWindow});
      if (command === 'quit') setImmediate(() => app.quit());
      return {ok: true, value: {...windowState(), error: startupError}};
    } catch (error) {return {ok: false, error: error.message};}
  });
  app.on('second-instance',(_event,argv)=>{if(argv.includes('--reset-window')||argv.includes('--panel'))showWindow({reset:argv.includes('--reset-window')});else showDock();});
  app.on('activate',()=>showDock());
  app.on('window-all-closed', () => {});
  const shutdown = createShutdown({
    onStart: () => {quitting = true; clearTimeout(preferenceTimer); savePreferences();},
    stop: () => service && !service.failure ? service.close() : undefined,
    flush:async()=>{ready=false;await writeRuntime({stoppedAt:new Date().toISOString(),visible:false,dock:dock?{...dock.state(),visible:false}:null});await writes;},
    exit:()=>{clearInterval(pinnedTimer);dock?.dispose();tray?.destroy();app.exit(0);},
    onError: error => {quitting = false; notifyError(`退出尚未完成：${error.message}`); showWindow();}
  });
  app.on('before-quit', event => {event.preventDefault(); void shutdown.request();});
  app.whenReady().then(async () => {
    try {preferences = await readPreferences(preferencesFile);}
    catch(error){preferencesWritable=false;preferences={alwaysOnTop:true,compact:false,mainVisible:false,dock:{visible:true,side:'left'}};startupError=error.message;}
    const area = preferences.bounds ? screen.getDisplayMatching(preferences.bounds).workArea : screen.getPrimaryDisplay().workArea;
    const recoverInitialPosition = !preferences.version || process.argv.includes('--reset-window');
    preferences.version = version;
    const bounds = fitBounds(preferences.bounds, area, preferences.compact);
    preferences.bounds ||= fitBounds(null, area, false);
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    window = new BrowserWindow({...bounds, title: '工作流观察', icon, frame: false, show: false,
      minWidth: Math.min(360, area.width), minHeight: Math.min(preferences.compact ? 220 : 420, area.height),
      alwaysOnTop: preferences.alwaysOnTop, backgroundColor: '#2d3832', autoHideMenuBar: true,
      webPreferences: {preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false}
    });
    window.setMenu(null);
    window.on('move', rememberBounds); window.on('resize', rememberBounds);
    window.on('close',event=>{if(!quitting){event.preventDefault();hideWindow();}});
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('render-process-gone', (_event, details) => notifyError(`面板显示进程停止：${details.reason}。历史继续保留，请退出后重开。`));
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r'))) {
        event.preventDefault(); send('workflow:action', 'refresh');
      }
    });
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
    dock=new TaskDock({preferences,onChange:dockChanged,onError:notifyError});
    applyPinnedWindows();
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
    tray.setToolTip('工作流观察 · 点击显示侧边任务条');tray.on('click',showDock);tray.on('double-click',()=>showWindow());updateTray();
    service = new BackendService(dataDirectory, {
      onData: value => {latest = value; send('workflow:data', value); void writeRuntime();},
      onDockData:value=>{latestDock=value;dock.setTaskCount(value.tasks?.length||0);send('workflow:dock-data',value);void writeRuntime();},
      onError: notifyError, onLog: message => log('backend', message)
    });
    service.ready.then(() => {ready = true; updateTray(); send('workflow:window-state', windowState()); void writeRuntime();}).catch(() => {});
    const showMain=preferences.mainVisible||process.argv.includes('--panel')||process.argv.includes('--reset-window');
    window.once('ready-to-show',()=>{if(showMain)showWindow({reset:recoverInitialPosition});});
    await Promise.all([window.loadFile(entry),dock.ready]);
    if(showMain)showWindow({reset:recoverInitialPosition});
    else if(preferences.dock.visible!==false)dock.show(false);
    savePreferences();send('workflow:window-state',windowState());void writeRuntime();
  }).catch(error => {log('startup', error.message); app.quit();});
}
