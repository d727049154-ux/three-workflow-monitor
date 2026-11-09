'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Workspace}=require('../plugin/workspace.cjs');
const {History}=require('../plugin/history.cjs');
const {Activity}=require('../plugin/activity.cjs');
const {SessionDirectory,validateWorkflow}=require('../plugin/workflows.cjs');
const {SkillsManager,attachManager}=require('../plugin/manager.cjs');
const {activate}=require('../plugin/backend.cjs');
const {sha}=require('../plugin/core.cjs');
async function fixture(){const parent=path.resolve(__dirname,'../qa/tests');await fs.mkdir(parent,{recursive:true});return fs.mkdtemp(path.join(parent,'optimization-'));}
const waitPublic={schema:'workflow-workspace/1',revision:0,favorites:[],recent:[],seen:null,workflows:[]};

test('unified search ranks exact names, supports Chinese aliases and typos, and distinguishes child IDs',async()=>{
  const {buildEntries,targetKey}=await import('../plugin/targets.mjs');const {SearchIndex}=await import('../plugin/search.mjs');
  const snapshot={projects:[{id:'eagle',title:'Eagle 参考',tasks:[{id:'t1',title:'白模动作复刻',items:[{id:'same',title:'后空翻检查',detail:'动作接触'}]}],workflow:{stages:[]}}]};
  const catalog={skills:[{id:'s1',title:'Blender 灯光',name:'blender-lighting',callName:'blender-lighting',description:'布光与渲染',workflows:['car'],supports:[]}],resources:[{id:'r1',title:'动作库',category:'白模',workflows:['white'],library:{entries:[{id:'same',kind:'motion',title:'后空翻',category:'跳跃'}]}}]};
  const entries=buildEntries(snapshot,catalog);const index=new SearchIndex(entries);
  assert.equal(index.search('白膜')[0].title,'白模动作复刻');assert.equal(index.search('edgle')[0].target.kind,'workflow');
  assert.equal(index.search('blendr')[0].target.id,'s1');assert.equal(index.search('后空翻')[0].target.kind,'motion');
  assert.equal(index.search('后空翻',{kind:'task'})[0].target.kind,'item');assert.equal(index.search('完全没有这条未知内容').length,0);
  assert.notEqual(targetKey({kind:'item',id:'same',parentId:'t1'}),targetKey({kind:'motion',id:'same',parentId:'r1'}));
});

test('favorites and recent entries persist across restart without rewriting prior configuration versions',async()=>{
  const root=await fixture();const workspace=await new Workspace(root).init();const target={kind:'skill',id:'s1'};
  await workspace.favorite(target,'技能一','one',true);const firstFile=(await fs.readdir(path.join(root,'workspace-history')))[0];const before=await fs.readFile(path.join(root,'workspace-history',firstFile));
  await workspace.visit(target,'技能一','one');await workspace.favorite({kind:'resource',id:'r1'},'资料','two',true);
  const restored=await new Workspace(root).init();assert.equal(restored.view().favorites.length,2);assert.equal(restored.view().recent[0].target.id,'s1');
  assert.deepEqual(await fs.readFile(path.join(root,'workspace-history',firstFile)),before);
  const rev=restored.view().revision;await restored.visit(target,'技能一','one');assert.equal(restored.view().revision,rev);
});

test('malformed workspace state is preserved and cannot silently replace saved workflows or bookmarks',async()=>{
  const root=await fixture();const file=path.join(root,'workspace.json');await fs.writeFile(file,'{broken');const workspace=await new Workspace(root).init();
  assert.match(workspace.view().error,/原文件已保留/);await assert.rejects(workspace.favorite({kind:'task',id:'t'},'task','t',true),/原文件已保留/);assert.equal(await fs.readFile(file,'utf8'),'{broken');
});

test('activity reading does not mark anything seen, and an older viewed head cannot acknowledge later changes',async()=>{
  const root=await fixture();const h=await new History(root).init();const workspace=await new Workspace(root).init();
  const project=n=>[{id:'test',title:'流程',sources:[],stateLabel:'记录',tasks:[{id:'task',title:'检查',workflow:'test',items:[],messages:[{text:`进展 ${n}`}],latestText:`进展 ${n}`,updatedAt:`2026-11-06T00:00:0${n}Z`}]}];
  await h.record(project(1),new Map());const activity=new Activity(h);const page=await activity.page();assert.equal(workspace.view().seen,null);
  await h.record(project(2),new Map());await workspace.acknowledge(await h.read(page.head.id));assert.equal(workspace.view().seen.id,1);
  assert.ok((await activity.page()).events.some(event=>event.snapshotId>workspace.view().seen.id));
  await h.record(project(2),new Map(),'checkpoint');assert.equal((await activity.events(3)).length,0);assert.equal((await h.verify()).snapshots,3);
});

test('new workflows register, read real progress, pause/resume and survive restart with exact history retained',async()=>{
  const root=await fixture();const project=path.join(root,'project');const data=path.join(root,'data');await fs.mkdir(project);await fs.mkdir(data);
  const values={eagleRoot:'',whiteRoot:'',whiteRun:'pilot',carRoot:'',carFlowRoot:'',taskLinksFile:'',codexSessionsRoot:'',catalogFile:'',managerRoot:'',managerApp:''};
  await fs.writeFile(path.join(data,'config.json'),JSON.stringify({revision:1,values}));const file=path.join(project,'workflow-progress.json');
  await fs.writeFile(file,JSON.stringify({schema:'workflow-progress/1',updatedAt:'2026-11-06T00:00:00Z',state:'running',stage:'制作',tasks:[{id:'shot-1',title:'第一镜',stage:'step-2',state:'running',detail:'正在制作'}]}));
  let backend=await activate({dataDirectory:data});
  try{
    const created=await backend.call('workflowSave',{expectedRevision:0,workflow:{title:'新产品流程',root:project,stages:['分析','制作','验收'],threadIds:[],autoDiscover:false,skillIds:[],resourceIds:[]}});const id=created.flow.id;
    const initial=created.view.snapshot;const card=initial.projects.find(p=>p.id===id);assert.equal(card.tasks[0].title,'第一镜');assert.equal(card.workflow.stages[1].taskCount,1);assert.equal(card.progress,null);
    const before=sha(await fs.readFile(path.join(data,'snapshots',`${String(initial.id).padStart(8,'0')}.json`)));
    await fs.writeFile(file,JSON.stringify({schema:'workflow-progress/1',updatedAt:'2026-11-06T00:01:00Z',state:'complete',stage:'制作',progress:{completed:1,total:2},tasks:[{id:'shot-1',title:'第一镜',stage:'step-2',state:'complete',detail:'已生成候选，尚未验收'}]}));
    const next=await backend.call('refresh');assert.equal(next.snapshot.projects.find(p=>p.id===id).state,'produced');assert.ok(next.snapshot.id>initial.id);
    assert.equal(sha(await fs.readFile(path.join(data,'snapshots',`${String(initial.id).padStart(8,'0')}.json`))),before);
    assert.equal((await backend.call('workflowPause',{id,paused:true})).snapshot.projects.some(p=>p.id===id),false);
    assert.equal((await backend.call('workspaceState')).workflows[0].paused,true);
    await backend.dispose();backend=await activate({dataDirectory:data});assert.equal((await backend.call('workspaceState')).workflows[0].id,id);
    assert.ok((await backend.call('workflowPause',{id,paused:false})).snapshot.projects.some(p=>p.id===id));
    assert.match((await backend.call('workflowPrompt',{id})).prompt,/workflow-progress.json/);
    await assert.rejects(backend.call('activitySeen',{id:initial.id,hash:'wrong'}),/不匹配/);
    await assert.rejects(backend.call('quickFavorite',{target:{kind:'task',id:'not-present'},enabled:true}),/入口已变化/);
    assert.ok((await backend.call('verify')).snapshots>=4);
  }finally{await backend.dispose();}
});

test('a new flow with no sources stays waiting for input and cannot contain arbitrary skill IDs',async()=>{
  const catalog={skills:[],resources:[]};const flow=await validateWorkflow({title:'尚待接入',root:'',stages:['设计','制作'],autoDiscover:true},catalog);
  assert.equal(flow.autoDiscover,false);assert.equal(flow.root,'');await assert.rejects(validateWorkflow({title:'异常',root:'relative',stages:['a']},catalog),/绝对/);
  await assert.rejects(validateWorkflow({title:'异常',root:'',stages:['a'],skillIds:['unknown']},catalog),/重选/);
  const {collect}=require('../plugin/core.cjs');const result=await collect({},{customWorkflows:[flow]});const card=result.projects.find(p=>p.id===flow.id);assert.equal(card.state,'unreported');assert.equal(card.progress,null);assert.equal(card.tasks.length,0);
});

test('new chats are discovered on the next directory refresh by exact project and identity, without subagents',async()=>{
  const root=await fixture();const sessions=path.join(root,'sessions');const day=path.join(sessions,'2026','11','06');const project=path.join(root,'project');await fs.mkdir(day,{recursive:true});await fs.mkdir(project);
  const first='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002',agent='00000000-0000-4000-8000-000000000003',other='00000000-0000-4000-8000-000000000004';
  const write=async(id,cwd,source='cli')=>{await fs.writeFile(path.join(day,`rollout-2026-11-06T12-00-00-${id}.jsonl`),JSON.stringify({type:'session_meta',payload:{id,cwd,source}})+'\n');await fs.appendFile(path.join(root,'session_index.jsonl'),JSON.stringify({id,thread_name:`聊天 ${id}`,updated_at:new Date().toISOString()})+'\n');};
  await write(first,project);await write(agent,project,{subagent:{thread_spawn:{}}});await write(other,path.join(root,'other'));
  const directory=new SessionDirectory();const flow={id:'flow-a',title:'新工作流',root:project,autoDiscover:true,threadIds:[],createdAt:new Date().toISOString()};
  let found=await directory.links([flow],sessions);assert.equal(found.links.length,1);assert.equal(found.links[0].threadId,first);assert.deepEqual(found.links[0].stages,[]);
  await write(second,project);directory.lastScan=0;found=await directory.links([flow],sessions);assert.equal(found.links.length,2);assert.ok(found.links.some(t=>t.threadId===second));
  assert.equal((await directory.links([{...flow,paused:true}],sessions)).links.length,0);
});

test('Skills Manager checks the actual account, separates metadata from matching deployment files and preserves plugin identity',async()=>{
  const root=await fixture();const managerRoot=path.join(root,'manager'),skill=path.join(managerRoot,'skills','sample'),codex=path.join(root,'codex'),appData=path.join(root,'data');
  await fs.mkdir(path.join(managerRoot,'bin'),{recursive:true});await fs.writeFile(path.join(managerRoot,'bin','.version'),'1.41.0');await fs.writeFile(path.join(managerRoot,'bin','skills-manager-cli.exe'),'fixture');await fs.mkdir(skill,{recursive:true});await fs.writeFile(path.join(skill,'SKILL.md'),'central');await fs.mkdir(path.join(codex,'sample'),{recursive:true});await fs.writeFile(path.join(codex,'sample','SKILL.md'),'different');
  const runner=async(_file,args)=>({stdout:JSON.stringify(args[1]==='repo'?{base_dir:managerRoot,skills_dir:path.join(managerRoot,'skills')}:args[1]==='agents'?[{key:'codex',display_name:'Codex',skills_dir:codex,installed:true,enabled:true}]:args[1]==='presets'?[{id:'p',name:'三维',skill_count:1}]:[{id:'s',name:'sample',path:skill,tags:['三维'],presets:['三维'],deployed_to:['codex']}])});
  const manager=new SkillsManager(appData,runner);let status=await manager.get(managerRoot);assert.equal(status.connected,true);assert.equal(status.skills[0].deployments[0].state,'different');
  await fs.writeFile(path.join(codex,'sample','SKILL.md'),'central');status=await manager.get(managerRoot,true);assert.equal(status.skills[0].deployments[0].state,'matched');
  const realPath=await fs.realpath(path.join(skill,'SKILL.md'));const catalog={skills:[{id:'a',realPath,workflows:[]},{id:'b',realPath:path.join(root,'plugin','SKILL.md'),workflows:[]}],resources:[]};const attached=attachManager(catalog,status);assert.equal(attached.skills[0].manager.name,'sample');assert.equal(attached.skills[1].manager,null);
  const wrong=new SkillsManager(appData,async()=>({stdout:JSON.stringify({base_dir:path.join(root,'wrong-account'),skills_dir:skill})}));assert.match((await wrong.get(managerRoot)).issue,/账户/);
});

test('resource registration supports directories and single files, exact file search and reversible hiding without modifying assets',async()=>{
  const root=await fixture();const data=path.join(root,'data');const assets=path.join(root,'assets');await fs.mkdir(data);await fs.mkdir(assets);const file=path.join(assets,'材质测试.mat');await fs.writeFile(file,'original material bytes');
  await fs.writeFile(path.join(data,'config.json'),JSON.stringify({revision:1,values:{eagleRoot:'',whiteRoot:'',whiteRun:'pilot',carRoot:'',carFlowRoot:'',taskLinksFile:'',codexSessionsRoot:'',catalogFile:'',managerRoot:'',managerApp:''}}));
  let backend=await activate({dataDirectory:data});
  try{
    const added=await backend.call('resourceSave',{expectedRevision:0,resource:{title:'材质集合',path:assets,category:'材质',workflows:['car'],skillIds:[]}});const resource=added.catalog.resources[0];assert.equal(resource.parts[0].label,'材质测试.mat');assert.equal(resource.available,true);
    const {buildEntries}=await import('../plugin/targets.mjs');const {SearchIndex}=await import('../plugin/search.mjs');const found=new SearchIndex(buildEntries(null,added.catalog)).search('材质测试.mat')[0];assert.equal(found.target.kind,'file');assert.equal(found.target.parentId,resource.id);
    await backend.call('quickFavorite',{target:found.target,enabled:true});assert.equal((await backend.call('workspaceState')).favorites.length,1);
    await backend.call('resourcePause',{id:resource.id,paused:true});assert.equal((await backend.call('catalog')).resources.length,0);assert.equal(await fs.readFile(file,'utf8'),'original material bytes');
    await backend.dispose();backend=await activate({dataDirectory:data});assert.equal((await backend.call('workspaceState')).resources[0].paused,true);
    const restored=await backend.call('resourcePause',{id:resource.id,paused:false});assert.equal(restored.catalog.resources.length,1);
    const exported=await backend.call('workspaceExport');const bundle=JSON.parse(await fs.readFile(exported.path));assert.equal(bundle.workspace.resources[0].id,resource.id);
    await assert.rejects(backend.call('resourceSave',{expectedRevision:bundle.workspace.revision,resource:{title:'无效',path:'relative',category:'资料',workflows:[]}}),/绝对/);
  }finally{await backend.dispose();}
});

test('editing paused workflows and resources preserves their cross-links without resuming scans',async()=>{
  const root=await fixture(),data=path.join(root,'data'),assets=path.join(root,'assets');await fs.mkdir(data);await fs.mkdir(assets);
  const file=path.join(assets,'原始资料.txt');await fs.writeFile(file,'keep original');
  await fs.writeFile(path.join(data,'config.json'),JSON.stringify({revision:1,values:{eagleRoot:'',whiteRoot:'',whiteRun:'pilot',carRoot:'',carFlowRoot:'',taskLinksFile:'',codexSessionsRoot:'',catalogFile:'',managerRoot:'',managerApp:''}}));
  const backend=await activate({dataDirectory:data});
  try{
    const created=await backend.call('workflowSave',{expectedRevision:0,workflow:{title:'关联验证',root:'',stages:['制作'],threadIds:[],autoDiscover:false,skillIds:[],resourceIds:[]}});
    const added=await backend.call('resourceSave',{expectedRevision:created.view.workspace.revision,resource:{title:'关联资料',path:assets,category:'文档',workflows:[created.flow.id],skillIds:[]}});
    let changed=await backend.call('workflowSave',{expectedRevision:added.workspace.revision,workflow:{...created.flow,stages:['制作'],resourceIds:[added.resource.id]}});
    await backend.call('workflowPause',{id:created.flow.id,paused:true});await backend.call('resourcePause',{id:added.resource.id,paused:true});
    let state=await backend.call('workspaceState');
    const edited=await backend.call('resourceSave',{expectedRevision:state.revision,resource:{...added.resource,title:'关联资料已编辑'}});
    assert.equal(edited.resource.paused,true);assert.deepEqual(edited.resource.workflows,[created.flow.id]);assert.equal(edited.catalog.resources.length,0);
    changed=await backend.call('workflowSave',{expectedRevision:edited.workspace.revision,workflow:{...changed.flow,title:'关联验证已编辑',stages:['制作']}});
    assert.equal(changed.flow.paused,true);assert.deepEqual(changed.flow.resourceIds,[added.resource.id]);assert.equal(changed.view.snapshot.projects.some(p=>p.id===created.flow.id),false);
    await backend.call('workflowPause',{id:created.flow.id,paused:false});const resumed=await backend.call('resourcePause',{id:added.resource.id,paused:false});
    assert.equal(resumed.catalog.resources[0].id,added.resource.id);assert.equal(await fs.readFile(file,'utf8'),'keep original');
  }finally{await backend.dispose();}
});

test('manual refresh immediately discovers new chats and resource files without waiting for automatic caches',async()=>{
  const root=await fixture(),data=path.join(root,'data'),project=path.join(root,'project'),sessions=path.join(root,'sessions'),day=path.join(sessions,'2026','11','06');
  await fs.mkdir(data);await fs.mkdir(project);await fs.mkdir(day,{recursive:true});
  await fs.writeFile(path.join(data,'config.json'),JSON.stringify({revision:1,values:{eagleRoot:'',whiteRoot:'',whiteRun:'pilot',carRoot:'',carFlowRoot:'',taskLinksFile:'',codexSessionsRoot:sessions,catalogFile:'',managerRoot:'',managerApp:''}}));
  const first='00000000-0000-4000-8000-000000000041',second='00000000-0000-4000-8000-000000000042';
  const writeChat=async id=>{const at=new Date().toISOString();await fs.writeFile(path.join(day,`rollout-2026-11-06T12-00-00-${id}.jsonl`),JSON.stringify({timestamp:at,type:'session_meta',payload:{id,cwd:project,source:'cli'}})+'\n');await fs.appendFile(path.join(root,'session_index.jsonl'),JSON.stringify({id,thread_name:`刷新验证 ${id}`,updated_at:at})+'\n');};
  await writeChat(first);const backend=await activate({dataDirectory:data});
  try{
    const added=await backend.call('resourceSave',{expectedRevision:0,resource:{title:'工程文档',path:project,category:'文档',workflows:[],skillIds:[]}});
    const flow=await backend.call('workflowSave',{expectedRevision:added.workspace.revision,workflow:{title:'刷新验证',root:project,stages:['制作'],autoDiscover:true,threadIds:[],skillIds:[],resourceIds:[added.resource.id]}});
    assert.equal(flow.view.snapshot.projects.find(p=>p.id===flow.flow.id).tasks.length,1);
    await writeChat(second);await fs.writeFile(path.join(project,'刷新新增资料.txt'),'new resource');
    assert.equal((await backend.call('refresh')).snapshot.projects.find(p=>p.id===flow.flow.id).tasks.length,1);
    const refreshed=await backend.call('refreshAll');assert.equal(refreshed.view.snapshot.projects.find(p=>p.id===flow.flow.id).tasks.length,2);
    assert.equal(refreshed.catalog.resources[0].parts[0].label,'刷新新增资料.txt');assert.equal(refreshed.history.entries[0].id,refreshed.view.snapshot.id);
  }finally{await backend.dispose();}
});
