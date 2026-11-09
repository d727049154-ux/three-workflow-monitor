'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {canonical, sha, nowIso} = require('./core.cjs');
function taskChanges(previous,projects){
  const before=new Map((previous?.projects||[]).flatMap(p=>(p.tasks||[]).map(task=>[task.id,task])));
  const current=projects.flatMap(p=>(p.tasks||[]).map(task=>({...task,workflow:p.id})));
  const changes=[];
  for(const task of current){
    const old=before.get(task.id);before.delete(task.id);
    const content=t=>canonical({messages:t.messages,items:t.items,session:t.session,focus:t.focus,stages:t.stages,issues:t.issues});
    if(!old||content(old)!==content(task))changes.push({taskId:task.id,title:task.title,workflow:task.workflow,kind:old?'updated':'linked',summary:String(task.priorityNote||task.latestText||'').slice(0,160)});
  }
  for(const task of before.values())changes.push({taskId:task.id,title:task.title,kind:'unlinked',summary:'已解除关联，旧快照保留'});
  for(const project of projects.filter(project=>project.custom)){
    const old=previous?.projects.find(p=>p.id===project.id);
    const content=p=>canonical({state:p.state,phase:p.phase,summary:p.summary,progress:p.progress,workflow:p.workflow,issues:p.issues});
    if(!old||content(old)!==content(project))changes.push({workflow:project.id,title:project.title,kind:old?'workflow-updated':'workflow-linked',summary:`${project.stateLabel} · ${project.phase}${project.summary?` · ${project.summary}`:''}`});
  }
  return changes;
}
class History {
  constructor(root) {this.root = root; this.last = null; this.ids = [];}
  file(id) {if (!Number.isSafeInteger(id) || id < 1) throw new Error('无效快照编号'); return path.join(this.root, 'snapshots', `${String(id).padStart(8, '0')}.json`);}
  async init() {
    await fs.mkdir(path.join(this.root, 'snapshots'), {recursive: true});
    await fs.mkdir(path.join(this.root, 'evidence'), {recursive: true});
    this.ids = (await fs.readdir(path.join(this.root, 'snapshots'))).filter(f => /^\d{8,}\.json$/.test(f)).map(f => Number(f.slice(0, -5))).sort((a, b) => a - b);
    if (this.ids.length) this.last = await this.read(this.ids.at(-1));
    return this;
  }
  async read(id) {
    const value = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
    const {hash, ...payload} = value;
    if (value.id !== id || sha(canonical(payload)) !== hash) throw new Error(`快照 #${id} 校验失败；原文件已保留`);
    return value;
  }
  async record(projects, evidence, reason = 'change', config = null) {
    const fingerprint = sha(canonical({projects, config}));
    if (this.last?.fingerprint === fingerprint && reason === 'change') return this.last;
    for (const [hash, bytes] of evidence) {
      if (sha(bytes) !== hash) throw new Error('来源副本校验失败');
      const file = path.join(this.root, 'evidence', `${hash}.txt`);
      try {await fs.writeFile(file, bytes, {flag: 'wx'});} catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (sha(await fs.readFile(file)) !== hash) throw new Error('既有来源副本已变化，停止写入');
      }
    }
    const id = (this.ids.at(-1) || 0) + 1;
    const payload = {schema: 'workflow-snapshot/1', id, observedAt: nowIso(), reason, previousHash: this.last?.hash || null, fingerprint, config, projects,changes:taskChanges(this.last,projects)};
    const snapshot = {...payload, hash: sha(canonical(payload))};
    const target = this.file(id);
    const pending = `${target}.pending-${process.pid}`;
    const handle = await fs.open(pending, 'wx');
    try {await handle.writeFile(JSON.stringify(snapshot, null, 2)); await handle.sync();} finally {await handle.close();}
    // Never replace an older committed snapshot, including in an accidental second writer.
    await fs.link(pending, target);
    await fs.unlink(pending);
    this.ids.push(id); this.last = snapshot;
    return snapshot;
  }
  async list(before = Infinity) {
    const ids = this.ids.filter(id => id < before).slice(-30).reverse();
    const records = await Promise.all(ids.map(id => this.read(id)));
    return {total: this.ids.length, entries: records.map(({id, observedAt, reason, hash, projects,changes=[]}) => ({id, observedAt, reason, hash,changes,summary:changes.length?`${changes.slice(0,2).map(c=>`${c.kind==='linked'?'关联':'更新'}「${c.title}」：${c.summary.slice(0,70)}`).join(' · ')}${changes.length>2?` · 另 ${changes.length-2} 个任务`:''}`:projects.map(p => `${p.title}：${p.stateLabel}`).join(' · ')})), nextBefore: ids.length ? ids.at(-1) : null};
  }
  async verify() {
    let previous = null, expected = 1;
    const checked = new Set();
    for (const id of this.ids) {
      if (id !== expected++) throw new Error(`历史编号不连续：#${id}`);
      const snapshot = await this.read(id);
      if (snapshot.previousHash !== previous) throw new Error(`快照 #${id} 的前序校验不一致`);
      previous = snapshot.hash;
      for (const project of snapshot.projects) for (const source of project.sources) {
        if (checked.has(source.sha256)) continue;
        if (!/^[0-9a-f]{64}$/.test(source.sha256)) throw new Error('无效来源摘要');
        const bytes = await fs.readFile(path.join(this.root, 'evidence', `${source.sha256}.txt`));
        if (sha(bytes) !== source.sha256) throw new Error('来源副本校验失败');
        checked.add(source.sha256);
      }
    }
    return {snapshots: this.ids.length, sources: checked.size, verifiedAt: nowIso(), headHash: previous};
  }
  async export() {
    const integrity = await this.verify();
    const entries = await Promise.all(this.ids.map(id => this.read(id)));
    const hashes = [...new Set(entries.flatMap(e => e.projects.flatMap(p => p.sources.map(s => s.sha256))))];
    const evidence = Object.fromEntries(await Promise.all(hashes.map(async hash => [hash, (await fs.readFile(path.join(this.root, 'evidence', `${hash}.txt`))).toString('base64')])));
    const output = path.join(this.root, 'exports'); await fs.mkdir(output, {recursive: true});
    const file = path.join(output, `workflow-history-${Date.now()}.json`);
    const bytes = JSON.stringify({schema: 'workflow-history-export/1', integrity, entries, evidence}, null, 2);
    if (Buffer.byteLength(bytes) > 100 * 1024 * 1024) throw new Error('历史超过单次导出上限，原记录完整保留');
    await fs.writeFile(file, bytes, {flag: 'wx'});
    return {path: file, sha256: sha(bytes), ...integrity};
  }
}
module.exports = {History};
