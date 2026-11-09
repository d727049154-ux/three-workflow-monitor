'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_TAIL = 2 * 1024 * 1024;
const STAGE_IDS = {eagle:['reference','archive','edit','sound','delivery','listen'],white:['input','observe','scene','animate','delivery','review'],car:['reference','asset','motion','compare','render','reopen']};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => {const relative=path.relative(root,target);return !path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`);};
const iso = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function publicText(value) {
  return String(value || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '[画面见原聊天]')
    .replace(/data:[^\s)]+/g, '[媒体已省略]').replace(/\b(?:sk-|sk_live_)[A-Za-z0-9_-]{16,}/g, '[凭据已隐藏]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').trim().slice(0,6000);
}
function validateLinks(value) {
  if(value?.schema!=='workflow-task-links/1'||!Array.isArray(value.tasks)||value.tasks.length>80)throw new Error('小任务关联清单格式无效');
  const ids=new Set();
  return value.tasks.map(link=>{
    if(!/^[a-f0-9-]{36}$/.test(link.threadId)||link.id!==link.threadId||ids.has(link.id))throw new Error('聊天标识无效或重复');
    ids.add(link.id);
    if(!STAGE_IDS[link.workflow]||!Array.isArray(link.stages)||link.stages.some(id=>!STAGE_IDS[link.workflow].includes(id)))throw new Error('小任务环节关联无效');
    if(!path.isAbsolute(link.projectRoot)||path.isAbsolute(link.sessionFile)||!inside(path.resolve('/sessions'),path.resolve('/sessions',link.sessionFile))||!path.basename(link.sessionFile).endsWith(`-${link.threadId}.jsonl`))throw new Error('小任务来源路径无效');
    return {...link,title:publicText(link.title).slice(0,160),focus:publicText(link.focus).slice(0,240),reports:(link.reports||[]).slice(0,12)};
  });
}
function initialState(link,previous) {
  const seed=link.seed||{};
  const state={messages:(seed.messages||[]).map(m=>({id:m.id,phase:m.phase,text:publicText(m.text),at:null,seed:true})),
    turnId:seed.turnId||null,turnStatus:seed.turnStatus||'unknown',statusAt:iso(seed.completedAt)||iso(seed.startedAt)||iso(seed.observedAt),
    seedObservedAt:iso(seed.observedAt),offset:0,size:0,mtime:0,identity:false,activityAt:null};
  if(previous?.threadId===link.threadId&&previous.projectRoot===link.projectRoot){
    if(previous.messages?.length)state.messages=previous.messages.map(m=>({...m})).slice(-8);
    if(previous.session?.statusAt&&(!state.statusAt||previous.session.statusAt>=state.statusAt)){
      state.turnId=previous.session.turnId;state.turnStatus=previous.session.status;state.statusAt=previous.session.statusAt;
    }
  }
  return state;
}
function consume(state, record) {
  const p=record.payload||{},at=iso(record.timestamp);
  if(!at)return;
  // On Windows an open writer can leave file mtime unchanged. Event timestamps
  // are the activity signal; they stay outside persisted progress fingerprints.
  if(Date.parse(at)<=Date.now()+300000&&(!state.activityAt||at>state.activityAt))state.activityAt=at;
  if(record.type==='event_msg'&&['task_started','task_complete','turn_aborted','task_failed','error'].includes(p.type)&&(!state.statusAt||at>=state.statusAt)){
    const preserveFailure=p.type==='task_complete'&&p.turn_id===state.turnId&&state.turnStatus==='failed';
    state.turnId=p.turn_id||state.turnId;state.statusAt=at;
    if(!preserveFailure)state.turnStatus=p.type==='task_started'?'inProgress':p.type==='task_complete'?'completed':p.type==='turn_aborted'?'interrupted':'failed';
  }
  if(record.type!=='response_item'||p.type!=='message'||p.role!=='assistant'||!['commentary','final_answer','final'].includes(p.phase))return;
  const text=publicText((p.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('\n'));
  if(!text)return;
  state.messages=state.messages.filter(m=>!m.seed&&m.id!==p.id&&m.text!==text);
  state.messages.push({id:p.id||digest(text),phase:p.phase,text,at});
  state.messages.sort((a,b)=>(a.at||'').localeCompare(b.at||''));state.messages=state.messages.slice(-8);
}
class TaskFeed {
  constructor(){this.cache=new Map();this.previous=new Map();}
  restore(tasks){this.previous=new Map(tasks.map(task=>[task.id,task]));}
  async read(link,sessionRoot){
    if(!sessionRoot)throw new Error('尚未关联 Codex 会话记录目录');
    const file=path.resolve(sessionRoot,link.sessionFile);
    if(!inside(path.resolve(sessionRoot),file))throw new Error('聊天路径超出已关联目录');
    const key=`${file}:${link.threadId}`;let state=this.cache.get(key);
    if(!state){state=initialState(link,this.previous.get(link.id));this.cache.set(key,state);}
    const [realRoot,realFile]=await Promise.all([fs.realpath(sessionRoot),fs.realpath(file)]);
    if(!inside(realRoot,realFile))throw new Error('聊天文件链接指向关联目录之外');
    const handle=await fs.open(file,'r');
    try{
      const stat=await handle.stat();if(!stat.isFile())throw new Error('聊天来源不是普通文件');
      if(!state.identity||stat.size<state.size){
        state=initialState(link,this.previous.get(link.id));this.cache.set(key,state);
        const head=Buffer.alloc(Math.min(stat.size,256*1024));await handle.read(head,0,head.length,0);
        const newline=head.indexOf(10);if(newline<0)throw new Error('无法核验聊天文件头');
        const metadata=JSON.parse(head.subarray(0,newline).toString('utf8'));
        if(metadata.type!=='session_meta'||metadata.payload?.id!==link.threadId)throw new Error('聊天文件与关联标识不匹配');
        if(path.resolve(metadata.payload.cwd||'')!==path.resolve(link.projectRoot))throw new Error('聊天所属工程与关联清单不一致');
        state.identity=true;
      }
      if(stat.size!==state.size||stat.mtimeMs!==state.mtime){
        const start=Math.max(state.offset,stat.size-MAX_TAIL,0);
        const bytes=Buffer.alloc(stat.size-start);const read=await handle.read(bytes,0,bytes.length,start);const data=bytes.subarray(0,read.bytesRead);
        let begin=0;if(start>state.offset||(start>0&&state.offset===0)){const first=data.indexOf(10);begin=first<0?data.length:first+1;}
        const end=data.lastIndexOf(10);
        if(end>=begin){
          for(const line of data.subarray(begin,end).toString('utf8').split('\n')){try{consume(state,JSON.parse(line));}catch{/* A partial/corrupt event never becomes progress. */}}
          state.offset=start+end+1;
        }
        state.size=stat.size;state.mtime=stat.mtimeMs;
      }
      const messages=state.messages.map(m=>({...m}));
      const updatedAt=messages.filter(m=>m.at).at(-1)?.at||state.seedObservedAt;
      const terminal=['completed','failed','interrupted'].includes(state.turnStatus);
      const activityAt=state.activityAt||stat.mtime.toISOString();const recent=Date.now()-Date.parse(activityAt)<120000;
      const liveLabel=state.turnStatus==='failed'?'聊天异常':state.turnStatus==='interrupted'?'聊天已中断':terminal?'回合已结束':recent?'记录持续更新':'记录暂未更新';
      return {file,messages,updatedAt,session:{turnId:state.turnId,status:state.turnStatus,statusAt:state.statusAt},
        live:{id:link.id,label:liveLabel,active:!terminal&&recent,recordActivityAt:activityAt}};
    }finally{await handle.close();}
  }
}
function reportItems(type,value,label,source){
  const item=(id,title,detail,stages,stateLabel='已有记录')=>({id,title,detail,stages,stateLabel,sourcePath:source.path,sourceHash:source.sha256,updatedAt:source.modifiedAt});
  if(type==='cycles-wait'){
    const labels={timed_out_waiting_resources:'资源等待已超时',waiting_resources:'记录为等待资源',complete:'采样记录已完成',failed:'采样失败'};
    const state=labels[value.status]||`队列记录：${value.status||'未登记'}`;
    return [item('cycles-wait',label,`${state}。目标 ${value.expected_sampling_frames||'未登记'} 张；已登记采样组 ${(value.groups||[]).length}。最低可提交内存 ${value.minimum_available_commit_gib||'未登记'} GiB，需稳定 ${value.stable_seconds_required||'未登记'} 秒。画面验收：${value.visual_acceptance==='not_tested'?'未测试':'见原记录'}。`,['render'],state)];
  }
  if(type==='timeline'){
    const markers=value.opened_scene_state?.timeline_markers;
    if(Array.isArray(markers))return markers.slice(0,50).map((m,i)=>item(`timeline-${i}`,m.name,`起始帧 ${m.frame} · ${m.camera}；${value.status==='saved_marker_mapping_pass'?'已核对保存后的相机标记':'状态见来源'}。画面与播放验收另记。`,['motion','reopen'],'标记已记录'));
    return [item('saved-markers',label,`${value.saved_marker_count||'未登记'} 个相机标记，覆盖 ${value.validated_timeline_frames||value.mapped_frames||'未登记'} 帧。原记录：${value.status||'未登记'}。${value.open_at_scene_start===false?'工程打开时未位于首帧，仍待处理。':''}画面验收另记。`,['motion','reopen'])];
  }
  if(type==='acceptance-matrix')return String(value).split('\n').filter(line=>/^\|\s*C\d{2}\s*\|/.test(line)).slice(0,30).map(line=>{
    const cells=line.split('|').slice(1,-1).map(x=>x.trim());const code=cells[0];
    return item(code,`${code} · ${cells[1]}`,cells[3]||'状态未登记',code==='C08'?['compare']:['C07','C09','C10','C11'].includes(code)?['reopen']:['reference'],'验收记录');
  });
  return [];
}
async function collectTasks(reader,settings,feed,additional=[]){
  const result={tasks:[],sources:[],live:[],issues:[]};
  let links=[],linkedAt=null;
  if(settings.taskLinksFile){
    const mapping=await reader.read(path.dirname(settings.taskLinksFile),path.basename(settings.taskLinksFile),{json:true,role:'小任务与流程环节关联清单'});
    if(mapping.error)result.issues.push(mapping.error);
    else {result.sources.push(mapping.source);linkedAt=iso(mapping.value.observedAt);try{links=validateLinks(mapping.value);}catch(error){result.issues.push(error.message);}}
  }
  links.push(...additional);
  // Bound concurrency and disk reads; no whole-history scans, process launches or writes.
  for(const link of links){
    const task={id:link.id,threadId:link.threadId,title:link.title,focus:link.focus,workflow:link.workflow,stages:link.stages,projectRoot:link.projectRoot,linkedAt:link.linkedAt||linkedAt,messages:[],items:[],sources:[],issues:[],updatedAt:null};
    try{
      const data=await feed.read(link,settings.codexSessionsRoot);
      Object.assign(task,{messages:data.messages,updatedAt:data.updatedAt,session:data.session});result.live.push(data.live);
      const extracted={schema:'workflow-chat-extract/1',threadId:link.threadId,session:data.session,messages:data.messages};
      const bytes=Buffer.from(JSON.stringify(extracted));const sha256=digest(bytes);reader.evidence.set(sha256,bytes);
      task.sources.push({path:data.file,role:`聊天进展：${link.title}`,sha256,bytes:bytes.length,modifiedAt:data.updatedAt,scope:'公开进展摘录；不含推理、工具原文、用户消息及图片'});
    }catch(error){task.issues.push(`聊天暂不可读：${error.message}`);task.session={status:'unavailable'};result.live.push({id:task.id,label:'来源不可读',active:false});}
    for(const report of link.reports){
      const source=await reader.read(link.projectRoot,report.path,{json:report.type!=='acceptance-matrix',role:report.label});
      if(source.source)task.sources.push(source.source);
      if(source.error){task.issues.push(`${report.label}：${source.error}`);continue;}
      task.items.push(...reportItems(report.type,source.value,report.label,source.source).map(item=>({...item,id:`${report.path}:${item.id}`})));
      if(!task.updatedAt||source.source.modifiedAt>task.updatedAt)task.updatedAt=source.source.modifiedAt;
    }
    task.latestText=task.messages.at(-1)?.text||'尚无可用的文字进展，请查看已关联来源。';
    const timedOut=task.items.find(i=>i.stateLabel==='资源等待已超时');
    if(timedOut&&(!task.messages.at(-1)?.at||timedOut.updatedAt>=task.messages.at(-1).at)){task.priorityNote=timedOut.detail;task.priorityAt=timedOut.updatedAt;}
    task.sources.sort((a,b)=>a.path.localeCompare(b.path));result.tasks.push(task);
  }
  return result;
}
module.exports={TaskFeed,collectTasks,validateLinks,publicText,consume,STAGE_IDS};
