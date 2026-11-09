'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {ActiveTasks,taskState,reportedProgress}=require('../desktop/active-tasks.cjs');
const engineRoot=path.join(__dirname,'..','plugin');
const at=offset=>new Date(Date.now()+offset).toISOString();

test('unconfigured sessions stay waiting without creating history, and a missing optional title index is empty',async()=>{
  const root=path.join(__dirname,'..','qa','tests',`empty-sessions-${randomUUID()}`);
  const observer=await new ActiveTasks(path.join(root,'data'),{engineRoot}).init();
  try {
    for(const force of [true,false]) {
      const waiting=await observer.refresh({config:{codexSessionsRoot:''},snapshot:{projects:[]}},force);
      assert.equal(waiting.error,null);assert.equal(waiting.tasks.length,0);
      assert.match(waiting.scope,/尚未关联/);assert.equal(waiting.historyId,null);
    }
    const sessions=path.join(root,'sessions');await fs.mkdir(sessions,{recursive:true});
    const empty=await observer.refresh({config:{codexSessionsRoot:sessions},snapshot:{projects:[]}},true);
    assert.equal(empty.error,null);assert.equal(empty.tasks.length,0);assert.equal(empty.scanned,0);
  } finally {await observer.dispose();}
});
test('activity state does not confuse recent completed events, stale runs, or missing totals with current progress',()=>{
  assert.equal(taskState({session:{status:'completed'},live:{recordActivityAt:at(0)}}).show,false);
  assert.equal(taskState({session:{status:'inProgress'},live:{recordActivityAt:at(-600000)}}).label,'状态待同步');
  assert.equal(taskState({session:{status:'unknown'},live:{recordActivityAt:at(-600000)}},Date.now(),{isOngoing:true}).show,true);
  assert.equal(taskState({session:{status:'completed'}},Date.now(),{isOngoing:true}).show,false);
  const id=randomUUID(),report={schema:'workflow-progress/1',updatedAt:at(-1000),tasks:[{threadId:id,progress:{completed:2,total:5},state:'running'}]};
  assert.equal(reportedProgress(report,id).progress.percent,40);
  assert.equal(reportedProgress(report,randomUUID()),null);
  report.tasks[0].progress.completed=6;assert.equal(reportedProgress(report,id).progress,null);
  report.tasks[0].progress={completed:1,total:0};assert.equal(reportedProgress(report,id).progress,null);
});
test('side observer discovers human tasks after helper entries, updates new tasks, and preserves final history without archiving tool input',async()=>{
  const root=path.join(__dirname,'..','qa','tests',`active-${Date.now()}-${randomUUID()}`),sessions=path.join(root,'sessions'),day=path.join(sessions,'2026','11','06'),project=path.join(root,'project'),data=path.join(root,'data');
  await fs.mkdir(day,{recursive:true});await fs.mkdir(project,{recursive:true});
  const index=path.join(root,'session_index.jsonl');const id=randomUUID();
  async function add(thread,title,agent=false) {
    const file=path.join(day,`rollout-2026-11-06T10-00-00-${thread}.jsonl`);
    const records=[{timestamp:at(-60000),type:'session_meta',payload:{id:thread,cwd:project,source:agent?{subagent:{thread_spawn:{}}}:'cli'}},
      {timestamp:at(-60000),type:'event_msg',payload:{type:'task_started',turn_id:'turn-a'}},
      {timestamp:at(-30000),type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'正在核对第 2 个步骤。'}]}},
      {timestamp:at(-1000),type:'response_item',payload:{type:'function_call',name:'irrelevant',arguments:'private-tool-payload'}}];
    await fs.writeFile(file,records.map(item=>JSON.stringify(item)).join('\n')+'\n');
    await fs.appendFile(index,JSON.stringify({id:thread,thread_name:title,updated_at:at(agent?0:-600000)})+'\n');return file;
  }
  const source=await add(id,'用户正在进行的任务');
  for(let i=0;i<205;i++)await add(randomUUID(),`Guardian ${i}`,true);
  const view={config:{codexSessionsRoot:sessions},snapshot:{projects:[]}};
  const observer=await new ActiveTasks(data,{engineRoot}).init();
  try {
    const first=await observer.refresh(view,true);assert.equal(first.error,null);assert.equal(first.tasks.length,1);assert.equal(first.tasks[0].id,id);assert.equal(first.scanned,1);
    const originalId=first.historyId;const unchanged=await observer.refresh(view);assert.equal(unchanged.historyId,originalId);
    await fs.appendFile(source,JSON.stringify({timestamp:at(0),type:'response_item',payload:{type:'function_call',name:'irrelevant',arguments:'still-private'}})+'\n');
    assert.equal((await observer.refresh(view)).historyId,originalId);
    const secondId=randomUUID();const secondSource=await add(secondId,'刚新建的任务');assert.equal((await observer.refresh(view)).tasks.length,1);assert.equal((await observer.refresh(view,true)).tasks.length,2);
    await fs.rename(secondSource,secondSource+'.held');
    const unreadable=await observer.refresh(view,true);assert.equal(unreadable.tasks.length,2);assert.equal(unreadable.tasks.find(task=>task.id===secondId).state,'unreadable');
    await fs.rename(secondSource+'.held',secondSource);
    assert.equal((await observer.refresh(view,true)).tasks.find(task=>task.id===secondId).state,'running');
    await fs.writeFile(path.join(project,'workflow-progress.json'),JSON.stringify({schema:'workflow-progress/1',updatedAt:at(-1000),tasks:[{threadId:id,state:'running',stage:'核对',progress:{completed:2,total:5,label:'检查项'}}]}));
    const progressed=await observer.refresh(view);assert.equal(progressed.tasks.find(task=>task.id===id).progress.percent,40);assert.equal(progressed.tasks.find(task=>task.id===secondId).progress,null);
    await fs.appendFile(source,JSON.stringify({timestamp:at(0),type:'event_msg',payload:{type:'task_complete',turn_id:'turn-a'}})+'\n');
    const ended=await observer.refresh(view);assert.equal(ended.tasks.some(task=>task.id===id),false);assert.equal(ended.finished.find(task=>task.id===id).state,'completed');
    const restored=await new ActiveTasks(data,{engineRoot}).init();assert.equal(restored.value.tasks.some(task=>task.id===id),false);await restored.dispose();
    const old=await observer.call('dockSnapshot',{id:originalId});assert.equal(old.projects[0].tasks[0].title,'用户正在进行的任务');
    const exported=await observer.call('dockExport');const contents=await fs.readFile(exported.path,'utf8');assert.equal(contents.includes('private-tool-payload'),false);assert.equal(contents.includes('still-private'),false);
    const verified=await observer.history.verify();assert.ok(verified.snapshots>=3);
  }finally{await observer.dispose();}
});
