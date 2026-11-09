'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const profileIndex=process.argv.indexOf('--profile');
const profile=profileIndex<0?'':process.argv[profileIndex+1];
if(profileIndex>=0&&(!/^[a-z][a-z0-9-]{0,39}$/.test(profile||'')||profile==='preview'))throw new Error('验证 profile 名称无效');
const dataDirectory = profile?path.join(root,'qa','profiles',profile):path.join(root, 'qa', 'preview-profile');
const registryPath = path.join(root, 'qa', profile?`preview-server-${profile}.json`:'preview-server.json');
const lockPath = path.join(root, 'qa', profile?`preview-running-${profile}.lock`:'preview-running.lock');
const schema = 'three-workflow-preview/1';

function validUrl(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value)) return false;
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  return port > 0 && port <= 65535;
}
function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function readRecord() {
  try {
    const record = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    if (!validUrl(record.url) || record.dataDirectory !== dataDirectory) throw new Error('预览记录与本项目不符，已保留原文件');
    return record;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function publicRecord(record) {
  const {controlToken, ...rest} = record;
  return rest;
}
async function control(record, action) {
  if (record.schema !== schema || record.root !== root || !/^[a-f0-9]{48}$/.test(record.controlToken || '') || !/^[a-f0-9-]{36}$/.test(record.instanceId || '')) {
    throw new Error('旧预览没有安全控制接口；请先在启动它的终端中按 Ctrl+C');
  }
  const response = await fetch(`${record.url}/preview-control`, {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-Workflow-Control': record.controlToken},
    body: JSON.stringify({action, instanceId: record.instanceId}), signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error('预览身份核验失败，未操作其他进程');
  const result = await response.json();
  if (result.schema !== schema || result.instanceId !== record.instanceId || result.root !== root || result.dataDirectory !== dataDirectory) {
    throw new Error('预览身份不一致，未操作其他进程');
  }
  return result;
}
async function acquireLock() {
  await fs.mkdir(path.dirname(lockPath), {recursive: true});
  const owner = {pid: process.pid, instanceId: crypto.randomUUID()};
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await fs.writeFile(lockPath, JSON.stringify(owner), {flag: 'wx'}); return owner; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(await fs.readFile(lockPath, 'utf8')); }
      catch { throw new Error('已有启动锁尚未写完或不可读，请稍后重试'); }
      if (processExists(previous.pid)) throw new Error('本项目已有预览进程；请使用打开预览.cmd 复用');
      // Only this fixed, transient service lock is removed. History is untouched.
      await fs.unlink(lockPath);
    }
  }
  throw new Error('无法取得预览启动锁');
}
async function releaseLock(owner) {
  try {
    const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    if (current.instanceId === owner.instanceId) await fs.unlink(lockPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
module.exports = {root, dataDirectory, registryPath, schema, validUrl, processExists, readRecord, publicRecord, control, acquireLock, releaseLock};
