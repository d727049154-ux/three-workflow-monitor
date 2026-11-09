'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const within = (value, low, high) => Math.min(high, Math.max(low, value));
function fitBounds(saved, workArea, compact = false) {
  const width = within(Number.isFinite(saved?.width) ? saved.width : 396, Math.min(360, workArea.width), Math.min(720, workArea.width));
  const height = compact ? Math.min(244, workArea.height) : within(Number.isFinite(saved?.height) ? saved.height : 760, Math.min(420, workArea.height), workArea.height);
  const x = within(Number.isFinite(saved?.x) ? saved.x : workArea.x + (workArea.width - width) / 2, workArea.x, workArea.x + workArea.width - width);
  const y = within(Number.isFinite(saved?.y) ? saved.y : workArea.y + (workArea.height - height) / 2, workArea.y, workArea.y + workArea.height - height);
  return Object.fromEntries(Object.entries({x, y, width, height}).map(([key, value]) => [key, Math.round(value)]));
}
function compactTransition(preferences, current, workArea, compact) {
  const full = preferences.compact ? {...preferences.bounds} : {...current};
  const next = fitBounds({...full, x: current.x, y: current.y}, workArea, compact);
  return {full, next};
}
async function readPreferences(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || value.schema !== 'workflow-desktop-window/1') throw new Error('窗口配置格式无法识别');
    for (const key of ['alwaysOnTop', 'compact', 'mainVisible']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('窗口开关格式无效');
    if (value.bounds != null && (typeof value.bounds !== 'object' || Array.isArray(value.bounds) ||
      !['x','y','width','height'].every(key => Number.isSafeInteger(value.bounds[key])) ||
      value.bounds.width < 1 || value.bounds.height < 1 || value.bounds.width > 32768 || value.bounds.height > 32768)) throw new Error('窗口尺寸格式无效');
    const dock=value.dock;
    if(dock!==undefined&&(dock===null||typeof dock!=='object'||Array.isArray(dock)||
      (dock.visible!==undefined&&typeof dock.visible!=='boolean')||
      (dock.side!==undefined&&!['left','right'].includes(dock.side))||
      ['x','y'].some(key=>dock[key]!==undefined&&(!Number.isSafeInteger(dock[key])||Math.abs(dock[key])>131072)))) throw new Error('侧边条位置格式无效');
    return {bounds:value.bounds||undefined,alwaysOnTop:value.alwaysOnTop!==false,compact:value.compact===true,mainVisible:value.mainVisible===true,
      dock:{visible:dock?.visible!==false,side:dock?.side||'left',...(dock?.x!==undefined?{x:dock.x}:{}),...(dock?.y!==undefined?{y:dock.y}:{})},
      version:typeof value.version==='string'?value.version:undefined};
  } catch (error) {
    if (error.code === 'ENOENT') return {alwaysOnTop:true,compact:false,mainVisible:false,dock:{visible:true,side:'left'}};
    throw new Error(`窗口配置不可读，原文件已保留：${error.message}`);
  }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const pending = `${file}.pending-${process.pid}`;
  await fs.writeFile(pending, JSON.stringify(value, null, 2), {flag: 'w'});
  await fs.rename(pending, file);
}
module.exports = {fitBounds, compactTransition, readPreferences, writeJson};
