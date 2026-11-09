'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {root, readRecord, publicRecord, control, processExists} = require('./preview-state.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function running() {
  const record = await readRecord();
  if (!record || record.stoppedAt) return null;
  try { await control(record, 'status'); return record; }
  catch (error) {
    if (processExists(record.pid)) throw new Error(`已有预览进程但无法核验：${error.message}`);
    return null;
  }
}
async function launch() {
  const existing = await running();
  if (existing) return {record: existing, reused: true};
  const previous=await readRecord();
  fs.mkdirSync(path.join(root, 'qa'), {recursive: true});
  const logPath = path.join(root, 'qa', `preview-launch-${Date.now()}-${process.pid}.log`);
  const log = fs.openSync(logPath, 'wx');
  let child;
  try {
    const args=[path.join(root, 'tools', 'preview.cjs')];
    const profileIndex=process.argv.indexOf('--profile');if(profileIndex>=0)args.push('--profile',process.argv[profileIndex+1]);
    if(previous)args.push('--port',new URL(previous.url).port);
    child = spawn(process.execPath, args, {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log], shell: false
    });
    await new Promise((resolve, reject) => {child.once('spawn', resolve); child.once('error', reject);});
    child.unref();
  } finally { fs.closeSync(log); }
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(250);
    const record = await readRecord();
    if (record && !record.stoppedAt) {
      try { await control(record, 'status'); return {record, reused: record.pid !== child.pid}; }
      catch { /* The server may still be initializing. */ }
    }
  }
  throw new Error(`预览未就绪，启动日志：${logPath}`);
}
async function stop() {
  const record = await running();
  if (!record) return {stopped: true, alreadyStopped: true, historyPreserved: true};
  await control(record, 'stop');
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(250);
    const latest = await readRecord();
    if (latest?.instanceId === record.instanceId && latest.stoppedAt) {
      return {stopped: true, historyPreserved: true, instanceId: record.instanceId};
    }
  }
  throw new Error('停止请求已发送，但尚未确认退出；不会强制终止其他进程');
}
async function openBrowser(url) {
  if (process.platform !== 'win32') throw new Error(`请在浏览器打开 ${url}`);
  const child = spawn('explorer.exe', [url], {shell: false, windowsHide: true, detached: true, stdio: 'ignore'});
  await new Promise((resolve, reject) => {child.once('spawn', resolve); child.once('error', reject);});
  child.unref();
}
(async () => {
  const action = process.argv[2] || 'start';
  if (action === 'start') {
    const {record, reused} = await launch();
    if (!process.argv.includes('--no-open')) await openBrowser(record.url);
    console.log(JSON.stringify({...publicRecord(record), reused}));
  } else if (action === 'stop') console.log(JSON.stringify(await stop()));
  else if (action === 'status') {
    const record = await running();
    console.log(JSON.stringify(record ? {...publicRecord(record), running: true} : {running: false}));
  } else throw new Error('可用命令：start [--no-open]、status、stop');
})().catch(error => {console.error(error.message); process.exitCode = 1;});
