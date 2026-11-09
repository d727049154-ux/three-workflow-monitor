'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {RecentTaskFeed}=require('./recent-task-feed.cjs');
const {scanArtifacts, resolveArtifact, listAvailableArtifacts}=require('./task-artifacts.cjs');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function taskState(data, now = Date.now(), previous = null) {
  const status = data.session?.status;
  if (status === 'completed') return {state: 'completed', label: '回合已结束', show: false};
  if (status === 'interrupted') return {state: 'interrupted', label: '已中断', show: false};
  if (status === 'failed') return {state: 'failed', label: '任务异常', show: now - Date.parse(data.session.statusAt) < 86400000};
  const recent = now - Date.parse(data.live?.recordActivityAt) < 120000;
  if(status==='inProgress'){
    const dormant=now-Date.parse(data.live?.recordActivityAt)>86400000;
    return {state:dormant?'dormant':recent?'running':'stale',label:dormant?'超过一天未更新':recent?'进行中':'状态待同步',show:!dormant};
  }
  return {state:recent?'updating':'unknown',label:recent?'记录更新中':previous?.isOngoing?'状态待同步':'无近期记录',show:recent||previous?.isOngoing===true};
}
function reportedProgress(report, threadId, now = Date.now()) {
  if (report?.schema !== 'workflow-progress/1') return null;
  const matches = [report, ...(Array.isArray(report.tasks) ? report.tasks : [])].filter(item => item.threadId === threadId);
  if (matches.length !== 1) return null;
  const item = matches[0], updatedAt = item.updatedAt || report.updatedAt;
  const time = Date.parse(updatedAt);
  if (!Number.isFinite(time) || time > now + 300000) return null;
  const p = item.progress;
  const quantified = p && Number.isSafeInteger(p.completed) && Number.isSafeInteger(p.total) && p.completed >= 0 && p.total > 0 && p.completed <= p.total;
  return {updatedAt, stale: now - time > 120000, state: item.state, stage: String(item.stage || report.stage || '').slice(0,160),
    summary: String(item.detail || item.summary || '').slice(0,6000),
    progress: quantified ? {completed: p.completed, total: p.total, percent: Math.round(p.completed / p.total * 100), label: String(p.label || '已登记步骤').slice(0,80)} : null,
    items: (Array.isArray(item.items) ? item.items : []).slice(0,40).filter(value => value && typeof value.title === 'string').map((value,index) => ({id: String(value.id || index), title: value.title.slice(0,160), detail: String(value.detail || '').slice(0,2000), stateLabel: ({done:'已完成',running:'进行中',pending:'待处理',blocked:'受阻'})[value.state] || '状态未登记'}))};
}
class ActiveTasks {
  constructor(dataDirectory, {engineRoot=path.join(__dirname,'plugin'),historyRoot} = {}) {
    this.dataDirectory = dataDirectory;
    this.core = require(path.join(engineRoot,'core.cjs'));
    this.publicText = require(path.join(engineRoot,'tasks.cjs')).publicText;
    const {SessionDirectory} = require(path.join(engineRoot,'workflows.cjs'));
    const {History} = require(path.join(engineRoot,'history.cjs'));
    this.history = new History(historyRoot||path.join(dataDirectory,'active-task-history'));
    this.directory=new SessionDirectory();this.feed=new RecentTaskFeed(engineRoot);this.pending=Promise.resolve();
    this.byId=new Map();this.knownIds=new Set();this.lastDirectoryRead=0;this.candidates=[];this.closed=false;
    this.artifactIndexes = new Map();
  }
  async init() {
    await this.history.init();
    const previous=this.history.last?.projects?.[0]?.tasks || [];
    this.feed.restore(previous); this.byId = new Map(previous.map(task=>[task.id,task]));
    for(const task of previous)this.knownIds.add(task.id);
    this.value={schema:'workflow-active-tasks/1',tasks:previous.filter(task=>task.isOngoing),finished:previous.filter(task=>!task.isOngoing),checkedAt:null,historyId:this.history.last?.id||null,error:null,scope:'本机用户聊天'};
    return this;
  }
  queue(job) {const next=this.pending.then(job);this.pending=next.catch(()=>{});return next;}
  async discover(view, force) {
    const sessionRoot=view.config.codexSessionsRoot;
    if (!sessionRoot) {
      this.sessionRoot='';this.candidates=[];this.lastDirectoryRead=Date.now();
      return false;
    }
    if(!force&&this.sessionRoot===sessionRoot&&Date.now()-this.lastDirectoryRead<60000)return;
    await this.directory.scan(sessionRoot,force);
    const entries=new Map();
    for(const task of this.byId.values())if(task.isOngoing)entries.set(task.id,{id:task.id,title:task.title});
    const linked=(view.snapshot?.projects||[]).flatMap(project=>project.tasks||[]).filter(task=>uuid.test(task.threadId));
    for(const task of linked)entries.set(task.threadId,{id:task.threadId,title:task.title});
    if(view.config.taskLinksFile) {
      const seed=await new this.core.Reader().read(path.dirname(view.config.taskLinksFile),'active-task-seeds.json',{json:true,optional:true});
      if(seed?.value?.schema==='workflow-active-task-seeds/1')for(const item of (seed.value.threads||[]).slice(0,80))if(uuid.test(item.id)&&typeof item.title==='string')entries.set(item.id,item);
    }
    // Filter helper/guardian sessions before applying the human-chat limit.
    const indexFile=path.join(path.dirname(sessionRoot),'session_index.jsonl');
    const named=new Map();let handle;
    try {handle=await fs.open(indexFile,'r');} catch(error) {if(error.code!=='ENOENT')throw error;}
    if(handle)try {
      const stat=await handle.stat(),start=Math.max(0,stat.size-8*1024*1024),bytes=Buffer.alloc(Math.min(stat.size,8*1024*1024));
      const read=await handle.read(bytes,0,bytes.length,start);let text=bytes.subarray(0,read.bytesRead).toString('utf8');
      if(start)text=text.slice(text.indexOf('\n')+1);
      for(const line of text.split('\n'))try{const item=JSON.parse(line);if(uuid.test(item.id)&&typeof item.thread_name==='string')named.set(item.id,item);}catch{}
    } finally {await handle.close();}
    const recent=[...named.values()].sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)));
    for(const item of recent)if(entries.has(item.id))entries.set(item.id,{id:item.id,title:item.thread_name});
    const selected=[];const seen=new Set();
    for(const item of [...entries.values(),...recent.map(item=>({id:item.id,title:item.thread_name}))]) {
      if(seen.has(item.id))continue;seen.add(item.id);
      let header;try{header=await this.directory.header(item.id);}catch{continue;}
      if(!header)continue;
      selected.push({...header,threadId:item.id,id:item.id,title:this.publicText(item.title).slice(0,160)});
      if(selected.length>=200)break;
    }
    // A directory hiccup must not make an already observed task look finished.
    for(const old of this.candidates)if(this.byId.get(old.id)?.isOngoing&&!selected.some(item=>item.id===old.id))selected.push(old);
    this.candidates=selected;this.sessionRoot=sessionRoot;this.lastDirectoryRead=Date.now();
  }
  refresh(view,force=false) {return this.queue(async()=>{
    if(this.closed)return this.value;
    try {
      const configured=await this.discover(view,force);
      if(configured===false) {
        this.value={...this.value,tasks:[],checkedAt:this.core.nowIso(),error:null,scope:'尚未关联本机会话目录，请在完整面板的关联页配置'};
        return this.value;
      }
      const enriched=new Map((view.snapshot?.projects||[]).flatMap(project=>(project.tasks||[]).filter(task=>task.threadId).map(task=>[task.threadId,{...task,workflowTitle:project.title}])));
      const reader=new this.core.Reader(),reports=new Map(),records=[],live=[];let unreadable=0;
      for(const link of this.candidates) {
        const previous=this.byId.get(link.id);
        let data;try{data=await this.feed.read(link,this.sessionRoot);}catch{
          unreadable++;
          if(previous?.isOngoing){const retained={...previous,state:'unreadable',stateLabel:'来源暂不可读',readError:'任务记录暂时读取失败'};records.push(retained);this.byId.set(link.id,retained);}
          continue;
        }
        const status=taskState(data,Date.now(),previous);
        if(!status.show&&(previous?.state===status.state||(!previous&&status.state!=='dormant')))continue;
        const base=enriched.get(link.id);
        const matching=(view.snapshot?.projects||[]).filter(project=>project.root&&path.resolve(project.root).toLowerCase()===path.resolve(link.projectRoot).toLowerCase());
        const task={id:link.id,threadId:link.id,title:link.title,projectRoot:link.projectRoot,workflowTitle:base?.workflowTitle||'未归入工作流',focus:base?.focus||'',
          session:data.session,messages:data.messages,updatedAt:data.updatedAt,latestText:data.messages.at(-1)?.text||'还没有可展示的文字进展',
          items:base?.items||[],state:status.state,stateLabel:status.label,isOngoing:status.show,progress:null,sources:[]};
        if(!base&&matching.length===1)task.workflowTitle=matching[0].title;
        const extracted=Buffer.from(JSON.stringify({schema:'workflow-chat-extract/1',threadId:link.id,session:data.session,messages:data.messages}));
        const hash=this.core.sha(extracted);reader.evidence.set(hash,extracted);
        task.sources.push({path:data.file,role:'公开任务进展',sha256:hash,bytes:extracted.length,modifiedAt:data.updatedAt});
        const itemHashes=new Set(task.items.map(item=>item.sourceHash));
        for(const source of base?.sources||[])if(/^[a-f0-9]{64}$/.test(source.sha256)&&itemHashes.has(source.sha256)) {
          const bytes=await fs.readFile(path.join(this.dataDirectory,'evidence',`${source.sha256}.txt`));
          if(this.core.sha(bytes)!==source.sha256)throw new Error('原任务的报告来源副本校验失败');
          reader.evidence.set(source.sha256,bytes);task.sources.push(source);
        }
        if(!reports.has(link.projectRoot))reports.set(link.projectRoot,await reader.read(link.projectRoot,'workflow-progress.json',{json:true,optional:true,role:'明确关联本聊天的进度报告'}));
        const source=reports.get(link.projectRoot),reported=reportedProgress(source?.value,link.id);
        if(source?.error){task.readError='任务进度报告暂不可读';if(previous?.progress){task.progress=previous.progress;task.progressAt=previous.progressAt;task.progressStale=true;}}
        if(reported) {
          task.progress=reported.progress;task.progressAt=reported.updatedAt;task.progressStale=reported.stale;task.reportedStage=this.publicText(reported.stage);
          task.reportedSummary=this.publicText(reported.summary);task.items=[...task.items,...reported.items.map(item=>({...item,title:this.publicText(item.title),detail:this.publicText(item.detail)}))];
          if(source.source)task.sources.push(source.source);
          if(!reported.stale&&['blocked','waiting'].includes(reported.state)){task.state=reported.state;task.stateLabel=reported.state==='blocked'?'受阻':'等待中';}
        }
        records.push(task);live.push({id:link.id,activityAt:data.live.recordActivityAt});this.byId.set(task.id,task);this.knownIds.add(task.id);
      }
      records.sort((a,b)=>a.title.localeCompare(b.title,'zh-CN')||a.id.localeCompare(b.id));
      const sources=[...new Map(records.flatMap(task=>task.sources).map(source=>[`${source.path}:${source.sha256}`,source])).values()].sort((a,b)=>a.path.localeCompare(b.path));
      const used=new Set(sources.map(source=>source.sha256));
      const evidence=new Map([...reader.evidence].filter(([hash])=>used.has(hash)));
      const snapshot=await this.history.record([{id:'active-tasks',title:'进行中的任务',stateLabel:`${records.length} 个任务`,sources,tasks:records}],evidence,'change',{scope:'local-user-chats',limit:200});
      while(this.byId.size>512)this.byId.delete(this.byId.keys().next().value);
      this.value={schema:'workflow-active-tasks/1',tasks:records.filter(task=>task.isOngoing),finished:records.filter(task=>!task.isOngoing),live,checkedAt:this.core.nowIso(),historyId:snapshot.id,error:null,scanned:this.candidates.length,unreadable,
        scope:'本机用户聊天；每 15 秒读进展、每 60 秒发现新任务'};
      return this.value;
    } catch(error) {this.value={...this.value,checkedAt:this.core.nowIso(),error:`侧边任务读取未完成：${error.message}`};return this.value;}
  });}
  call(method,args={}) {return this.queue(async()=>{
    if(method==='dockCurrent')return this.value;
    if(method==='dockHistory')return this.history.list(args.before);
    if(method==='dockSnapshot'){const snapshot=await this.history.read(Number(args.id));for(const task of snapshot.projects?.[0]?.tasks||[])this.knownIds.add(task.id);return snapshot;}
    if(method==='dockExport')return this.history.export();
    if (method==='dockArtifacts' || method==='dockOpenArtifact') {
      if (!uuid.test(args.id) || !this.knownIds.has(args.id)) throw new Error('请从已观察到的任务选择产出');
      const header = await this.directory.header(args.id);
      if (!header) throw new Error('原聊天记录不可用');
      const root = await fs.realpath(this.sessionRoot);
      const file = await fs.realpath(path.join(root, header.sessionFile));
      if (!this.core.inside(root, file)) throw new Error('聊天文件超出会话目录');
      const index = await scanArtifacts(file, header.projectRoot, this.artifactIndexes.get(args.id));
      this.artifactIndexes.delete(args.id);
      this.artifactIndexes.set(args.id, index);
      if (this.artifactIndexes.size > 24) this.artifactIndexes.delete(this.artifactIndexes.keys().next().value);
      if (method==='dockOpenArtifact') {
        const artifact = index.artifacts.get(args.artifactId);
        if (!artifact) throw new Error('文件不在这条聊天的产出列表里');
        return resolveArtifact(artifact.target);
      }
      return listAvailableArtifacts(index);
    }
    if(method==='dockOpenThread') {
      if(!uuid.test(args.id)||!this.knownIds.has(args.id))throw new Error('请从已观察到的任务选择原聊天');
      if(process.platform!=='win32')throw new Error('此入口需要 Windows');
      return new Promise((resolve,reject)=>{const child=spawn('explorer.exe',[`codex://threads/${args.id}`],{shell:false,windowsHide:true,stdio:'ignore'});child.once('spawn',()=>resolve({opened:true}));child.once('error',reject);});
    }
    throw new Error('不支持的侧边任务操作');
  });}
  async dispose(){this.closed=true;await this.pending;}
}
module.exports={ActiveTasks,taskState,reportedProgress};
