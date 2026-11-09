'use strict';
const path = require('node:path');
const {Worker} = require('node:worker_threads');
const {validateCall} = require('./contract.cjs');
class BackendService {
  constructor(dataDirectory, {onData = () => {}, onDockData = () => {}, onError = () => {}, onLog = () => {}, workerFactory} = {}) {
    this.pending = new Map(); this.serial = 0; this.closing = false; this.failure = null;
    this.ready = new Promise((resolve, reject) => {this.resolveReady = resolve; this.rejectReady = reject;});
    this.ready.catch(() => {});
    this.closed = new Promise((resolve, reject) => {this.resolveClosed = resolve; this.rejectClosed = reject;});
    this.closed.catch(() => {});
    this.worker = workerFactory ? workerFactory() : new Worker(path.join(__dirname, 'worker.cjs'), {workerData: {dataDirectory}});
    const fail = error => {
      this.failure = error; this.rejectReady(error);
      for (const item of this.pending.values()) {clearTimeout(item.timer); item.reject(error);}
      this.pending.clear(); onError(error.message);
    };
    this.worker.on('message', message => {
      if (message.type === 'ready') {this.resolveReady(); return;}
      if (message.type === 'publish') {onData(message.value); return;}
      if (message.type === 'dock') {onDockData(message.value); return;}
      if (message.type === 'log') {onLog(message.message); return;}
      if (message.type === 'fatal') {fail(new Error(message.error)); return;}
      if (message.type === 'closed') {this.resolveClosed(); return;}
      if (message.type === 'close-error') {this.rejectClosed(new Error(message.error)); return;}
      if (message.type !== 'result') return;
      const item = this.pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer); this.pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error)); else item.resolve(message.value);
    });
    this.worker.on('error', fail);
    this.worker.on('exit', code => {
      if (this.closing && code === 0) this.resolveClosed();
      else {const error = new Error(`本机读取进程已退出（${code}），请退出面板后重新打开；原有历史保留。`); fail(error); this.rejectClosed(error);}
    });
  }
  async call(method, args = {}) {
    validateCall({method, args});
    if (this.closing) throw new Error('正在保存历史并退出，请稍候');
    if (this.failure) throw this.failure;
    await this.ready;
    if (this.closing) throw new Error('正在保存历史并退出，请稍候');
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id); reject(new Error('读取时间较长，请稍后刷新；现有历史保留。'));}, 120000);
      this.pending.set(id, {resolve, reject, timer});
      this.worker.postMessage({type: 'call', id, method, args});
    });
  }
  close() {
    if (!this.closing) {this.closing = true; this.worker.postMessage({type: 'dispose'});}
    return this.closed;
  }
}
module.exports = {BackendService};
