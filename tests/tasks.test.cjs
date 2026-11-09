'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {TaskFeed,collectTasks}=require('../plugin/tasks.cjs');
const {Reader,canonical,sha}=require('../plugin/core.cjs');
const {History}=require('../plugin/history.cjs');
const id='00000000-0000-4000-8000-000000000001';
const event=(at,type,payload)=>JSON.stringify({timestamp:at,type,payload})+'\n';
const message=(at,text,phase='commentary')=>event(at,'response_item',{id:sha(text).slice(0,16),type:'message',role:'assistant',phase,content:[{type:'output_text',text}]});
async function fixture(){
  const base=path.resolve(__dirname,'../qa/task-tests');await fs.mkdir(base,{recursive:true});
  const root=await fs.mkdtemp(path.join(base,'case-'));const sessions=path.join(root,'sessions'),project=path.join(root,'project');
  await fs.mkdir(sessions);await fs.mkdir(project);
  const sessionFile=`rollout-2026-11-05T10-11-33-${id}.jsonl`;const file=path.join(sessions,sessionFile);
  await fs.writeFile(file,event('2026-11-05T10:00:00Z','session_meta',{id,cwd:project})+event('2026-11-05T10:00:00Z','event_msg',{type:'task_started',turn_id:'turn1'})+message('2026-11-05T10:01:00Z','已生成预览，完整审片仍待完成。'));
  const mapping=path.join(root,'links.json');
  const link={id,threadId:id,title:'原聊天名称',focus:'汽车渲染',projectRoot:project,workflow:'car',stages:['render'],sessionFile,reports:[],seed:{turnStatus:'inProgress',turnId:'turn1',startedAt:'2026-11-05T10:00:00Z',observedAt:'2026-11-05T10:00:00Z',messages:[]}};
  await fs.writeFile(mapping,JSON.stringify({schema:'workflow-task-links/1',observedAt:'2026-11-05T10:00:00Z',tasks:[link]}));
  return {root,project,sessions,file,mapping,link,settings:{taskLinksFile:mapping,codexSessionsRoot:sessions}};
}
test('associations use exact session identity and never mark a completed turn as visual acceptance',async()=>{
  const f=await fixture();await fs.appendFile(f.file,event('2026-11-05T10:02:00Z','event_msg',{type:'task_complete',turn_id:'turn1'}));
  const result=await collectTasks(new Reader(),f.settings,new TaskFeed());
  assert.equal(result.tasks.length,1);assert.equal(result.tasks[0].title,'原聊天名称');assert.equal(result.tasks[0].session.status,'completed');
  assert.equal(result.live[0].active,false);assert.match(result.tasks[0].latestText,/仍待完成/);assert.equal(result.tasks[0].progress,undefined);
  await fs.writeFile(f.file,event('2026-11-05T10:00:00Z','session_meta',{id:'00000000-0000-4000-8000-000000000002',cwd:f.project})+message('2026-11-05T10:01:00Z','错误聊天'));
  const bad=await collectTasks(new Reader(),f.settings,new TaskFeed());assert.match(bad.tasks[0].issues[0],/标识不匹配/);assert.equal(bad.tasks[0].messages.length,0);
});
test('only public updates are archived; tool, reasoning, user and image content are excluded',async()=>{
  const f=await fixture();await fs.appendFile(f.file,event('2026-11-05T10:01:10Z','response_item',{type:'message',role:'assistant',phase:'analysis',content:[{type:'output_text',text:'INTERNAL_REASONING'}]})+event('2026-11-05T10:01:11Z','response_item',{type:'message',role:'user',content:[{type:'input_text',text:'PRIVATE_USER_TEXT'}]})+event('2026-11-05T10:01:12Z','response_item',{type:'function_call_output',output:'TOOL_SECRET'})+message('2026-11-05T10:03:00Z','已补完相机检查，![图](data:image/png;base64,IMAGE_SECRET) 仍未验收。'));
  const reader=new Reader();const result=await collectTasks(reader,f.settings,new TaskFeed());
  const source=result.tasks[0].sources[0];const copy=reader.evidence.get(source.sha256).toString('utf8');
  assert.doesNotMatch(copy,/INTERNAL_REASONING|PRIVATE_USER_TEXT|TOOL_SECRET|IMAGE_SECRET/);assert.match(copy,/已补完相机检查/);assert.match(source.scope,/摘录/);
});
test('incremental updates survive incomplete lines, and heartbeat alone does not create history',async()=>{
  const f=await fixture(),feed=new TaskFeed();
  const first=await collectTasks(new Reader(),f.settings,feed);const fingerprint=canonical(first.tasks);
  await fs.appendFile(f.file,event('2026-11-05T10:05:00Z','event_msg',{type:'item_completed',item:{type:'commandExecution',command:'PRIVATE_TOOL_TEXT'}}));
  const second=await collectTasks(new Reader(),f.settings,feed);assert.equal(canonical(second.tasks),fingerprint);
  const next=message('2026-11-05T10:06:00Z','第二个镜头开始检查');await fs.appendFile(f.file,next.slice(0,-2));
  assert.equal((await collectTasks(new Reader(),f.settings,feed)).tasks[0].latestText,first.tasks[0].latestText);
  await fs.appendFile(f.file,next.slice(-2));const third=await collectTasks(new Reader(),f.settings,feed);assert.equal(third.tasks[0].latestText,'第二个镜头开始检查');
});
test('bounded tail reading skips oversized media lines and accepts the subsequent public update',async()=>{
  const f=await fixture();await fs.appendFile(f.file,event('2026-11-05T10:04:00Z','response_item',{type:'function_call_output',output:'x'.repeat(3*1024*1024)})+message('2026-11-05T10:05:00Z','大图之后的真实进展'));
  const result=await collectTasks(new Reader(),f.settings,new TaskFeed());assert.equal(result.tasks[0].latestText,'大图之后的真实进展');
});
test('recent log events establish activity even when Windows file mtime is stale',async()=>{
  const f=await fixture();await fs.appendFile(f.file,event(new Date().toISOString(),'event_msg',{type:'item_completed',item:{type:'commandExecution'}}));
  await fs.utimes(f.file,new Date('2000-01-01'),new Date('2000-01-01'));
  const result=await collectTasks(new Reader(),f.settings,new TaskFeed());assert.equal(result.live[0].active,true);assert.equal(result.live[0].label,'记录持续更新');
});
test('restart reuses verified public excerpts so a limited tail does not fabricate a task change',async()=>{
  const f=await fixture(),feed=new TaskFeed();await collectTasks(new Reader(),f.settings,feed);
  await fs.appendFile(f.file,event('2026-11-05T10:04:00Z','response_item',{type:'function_call_output',output:'x'.repeat(3*1024*1024)})+message('2026-11-05T10:05:00Z','最新检查'));
  const previous=await collectTasks(new Reader(),f.settings,feed);const restarted=new TaskFeed();restarted.restore(previous.tasks);
  const next=await collectTasks(new Reader(),f.settings,restarted);assert.equal(canonical(next.tasks),canonical(previous.tasks));
});
test('newer queue outcome is explicit and snapshots retain previous task updates',async()=>{
  const f=await fixture();f.link.reports=[{type:'cycles-wait',path:'queue.json',label:'Cycles 采样队列'}];
  await fs.writeFile(f.mapping,JSON.stringify({schema:'workflow-task-links/1',tasks:[f.link]}));
  await fs.writeFile(path.join(f.project,'queue.json'),JSON.stringify({status:'timed_out_waiting_resources',groups:[],expected_sampling_frames:63,minimum_available_commit_gib:41,stable_seconds_required:60,visual_acceptance:'not_tested'}));
  const reader=new Reader(),feed=new TaskFeed();const one=await collectTasks(reader,f.settings,feed);assert.match(one.tasks[0].priorityNote,/等待已超时/);assert.equal(one.tasks[0].items[0].stages[0],'render');
  const h=await new History(path.join(f.root,'history')).init();const card=r=>[{id:'car',title:'汽车',stateLabel:'已关联',tasks:r.tasks,sources:[...r.sources,...r.tasks.flatMap(t=>t.sources)]}];
  await h.record(card(one),reader.evidence);
  await fs.appendFile(f.file,message('2026-11-05T10:06:00Z','已开始新的修正'));const nextReader=new Reader();const two=await collectTasks(nextReader,f.settings,feed);await h.record(card(two),nextReader.evidence);
  assert.match((await h.read(1)).projects[0].tasks[0].latestText,/预览/);assert.match((await h.read(2)).projects[0].tasks[0].latestText,/新的修正/);assert.equal((await h.verify()).snapshots,2);
  assert.match((await h.list()).entries[0].summary,/更新「原聊天名称」/);assert.equal((await h.read(2)).changes[0].taskId,id);
});
