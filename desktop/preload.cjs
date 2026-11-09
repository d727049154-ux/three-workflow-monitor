'use strict';
const {contextBridge, ipcRenderer} = require('electron');
async function invoke(channel, value) {
  const reply = await ipcRenderer.invoke(channel, value);
  if (!reply.ok) throw new Error(reply.error || '本次操作未完成');
  return reply.value;
}
function subscribe(channel, fn) {
  if (typeof fn !== 'function') throw new Error('回调无效');
  const handler = (_event, value) => fn(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
contextBridge.exposeInMainWorld('workflowApp', {
  call: (method, args = {}) => invoke('workflow:call', {method, args}),
  subscribe: fn => subscribe('workflow:data', fn),
  onDockData: fn => subscribe('workflow:dock-data', fn),
  command: name => invoke('workflow:window', name),
  onWindowState: fn => subscribe('workflow:window-state', fn),
  onAction: fn => subscribe('workflow:action', fn),
  onError: fn => subscribe('workflow:error', fn)
});
