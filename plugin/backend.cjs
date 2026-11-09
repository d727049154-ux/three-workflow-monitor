'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {collect, validateConfig, canonical, nowIso, inside} = require('./core.cjs');
const {History} = require('./history.cjs');
const {TaskFeed} = require('./tasks.cjs');
const {Catalog} = require('./catalog.cjs');
const {Workspace} = require('./workspace.cjs');
const {Activity} = require('./activity.cjs');
const {SessionDirectory,validateWorkflow,integrationPrompt} = require('./workflows.cjs');
const {SkillsManager,attachManager} = require('./manager.cjs');
const {validateResource} = require('./resources.cjs');
const defaults = require('./defaults.json');
exports.activate = async ({dataDirectory, publish = () => {}, log = () => {}}) => {
  await fs.mkdir(dataDirectory, {recursive: true});
  const configFile = path.join(dataDirectory, 'config.json');
  let config = {...defaults}, revision = 0, closed = false, pending = Promise.resolve(), current,liveTasks=[];
  const taskFeed=new TaskFeed();
  const catalog = new Catalog(dataDirectory);
  const workspace=await new Workspace(dataDirectory).init();
  const sessionDirectory=new SessionDirectory();
  const manager=new SkillsManager(dataDirectory);
  const {buildEntries,targetKey,validTarget}=await import('./targets.mjs');
  try {const saved = JSON.parse(await fs.readFile(configFile, 'utf8')); config = {...defaults, ...saved.values}; revision = saved.revision;} catch (e) {if (e.code !== 'ENOENT') throw new Error('插件配置不可读，已保留原文件');}
  const history = await new History(dataDirectory).init();
  const activity=new Activity(history);
  taskFeed.restore((history.last?.projects||[]).flatMap(project=>project.tasks||[]));
  function queue(task) {const result = pending.then(task); pending = result.catch(() => {}); return result;}
  function payload(record, error = null) {return {schema: 'workflow-view/1', snapshot: record, totalSnapshots: history.ids.length, checkedAt: nowIso(), error:error||workspace.error, config: {...config}, configRevision: revision, dataDirectory,liveTasks,workspace:workspace.view()};}
  async function getCatalog(force=false){return attachManager(await catalog.get(config.catalogFile,force,workspace.value.resources||[]),await manager.get(config.managerRoot,force),workspace.value.workflows);}
  async function targetEntry(input){const target=validTarget(input);const inventory=['workflow','task','item'].includes(target.kind)?null:await getCatalog();const entry=buildEntries(current?.snapshot,inventory).find(item=>item.key===targetKey(target));if(!entry)throw new Error('入口已变化，请刷新后重选');return entry;}
  function publishWorkspace(){if(current){current={...current,workspace:workspace.view()};publish(current);}return workspace.view();}
  async function refresh(reason = 'change') {
    if (closed) return current;
    try {
      let discovery={links:[],issues:[]};
      try{discovery=await sessionDirectory.links(workspace.value.workflows,config.codexSessionsRoot);}catch(error){discovery.issues=workspace.value.workflows.map(flow=>({flow:flow.id,message:`自动关联暂未完成：${error.message}`}));}
      const result = await collect(config,{taskFeed,customWorkflows:workspace.value.workflows,additionalLinks:discovery.links,discoveryIssues:discovery.issues});
      const recordedConfig=workspace.value.workflows.length?{...config,customWorkflows:workspace.value.workflows}:config;
      const record = await history.record(result.projects, result.evidence, reason, recordedConfig);
      liveTasks=result.liveTasks;
      current = payload(record); publish(current); return current;
    } catch (error) {
      current = payload(history.last, `本次同步未完成：${error.message}`); publish(current); return current;
    }
  }
  await queue(() => refresh());
  const timer = setInterval(() => queue(() => refresh()).catch(e => log(e.message)), 15000);
  timer.unref?.();
  async function reveal(target) {
    if (process.platform !== 'win32') throw new Error('此打开方式仅适用于 Windows');
    const stat = await fs.stat(target);
    const args = stat.isDirectory() ? [target] : ['/select,', target];
    // Explorer is the interactive surface requested by the user, not a hidden helper.
    return new Promise((resolve, reject) => {const child = spawn('explorer.exe', args, {shell: false, windowsHide: false, stdio: 'ignore'}); child.once('spawn', () => resolve({requested: true})); child.once('error', reject);});
  }
  async function openFolder(target) {
    const allowed = [dataDirectory, config.eagleRoot, config.whiteRoot, config.carRoot, config.carFlowRoot,config.codexSessionsRoot,...workspace.value.workflows.map(flow=>flow.root),...(current?.snapshot?.projects||[]).flatMap(p=>(p.tasks||[]).map(t=>t.projectRoot))].filter(Boolean);
    if (!allowed.some(root => inside(root, target))) throw new Error('目录不在已关联范围内');
    return reveal(target);
  }
  return {
    call(method, args = {}) {return queue(async () => {
      if (closed) throw new Error('插件已停用');
      if (method === 'current') return current;
      if (method === 'refresh') return refresh();
      if (method === 'refreshAll') {
        sessionDirectory.lastScan=0;
        const view=await refresh();
        return {view,catalog:await getCatalog(true),history:await history.list()};
      }
      if (method === 'checkpoint') return refresh('checkpoint');
      if (method === 'history') return history.list(args.before);
      if (method === 'snapshot') return history.read(Number(args.id));
      if (method === 'verify') return history.verify();
      if (method === 'export') return history.export();
      if (method === 'catalog') return getCatalog();
      if (method === 'catalogRefresh') return getCatalog(true);
      if (method === 'catalogExport') {await getCatalog(); return catalog.export();}
      if (method === 'catalogOpen') return reveal(await catalog.resolveTarget(args));
      if(method==='workspaceState')return workspace.view();
      if(method==='quickFavorite'){
        if(typeof args.enabled!=='boolean')throw new Error('收藏状态无效');
        const target=validTarget(args.target);const entry=args.enabled?await targetEntry(target):null;
        await workspace.favorite(target,entry?.title||'',targetKey(target),args.enabled);return publishWorkspace();
      }
      if(method==='quickVisit'){const entry=await targetEntry(args.target);await workspace.visit(entry.target,entry.title,entry.key);return publishWorkspace();}
      if(method==='activity')return activity.page(args.before);
      if(method==='activitySeen'){const record=await history.read(args.id);if(record.hash!==args.hash)throw new Error('显示的快照已不匹配，请刷新变化列表');await workspace.acknowledge(record);return publishWorkspace();}
      if(method==='workflowSave'){
        if(args.expectedRevision!==workspace.value.revision)throw new Error('流程配置已更新，请重新打开新增/编辑页面');
        const inventory=await getCatalog();
        const resources=[...inventory.resources,...(workspace.value.resources||[]).filter(item=>item.paused)];
        const flow=await validateWorkflow(args.workflow,{...inventory,resources},workspace.value.workflows);
        await workspace.save({...workspace.value,workflows:[...workspace.value.workflows.filter(item=>item.id!==flow.id),flow]});
        sessionDirectory.lastScan=0;const view=await refresh('configuration');return {flow,view};
      }
      if(method==='workflowPause'){
        if(typeof args.paused!=='boolean'||!workspace.value.workflows.some(flow=>flow.id===args.id))throw new Error('工作流不存在');
        await workspace.save({...workspace.value,workflows:workspace.value.workflows.map(flow=>flow.id===args.id?{...flow,paused:args.paused,updatedAt:nowIso()}:flow)});return refresh('configuration');
      }
      if(method==='workflowPrompt'){const flow=workspace.value.workflows.find(flow=>flow.id===args.id);if(!flow)throw new Error('工作流不存在');return {prompt:integrationPrompt(flow)};}
      if(method==='resourceSave'){
        if(args.expectedRevision!==workspace.value.revision)throw new Error('资源配置已更新，请重新打开添加/编辑页面');
        const projects=[...(current?.snapshot?.projects||[]),...workspace.value.workflows.filter(flow=>flow.paused)];
        const resource=await validateResource(args.resource,await getCatalog(),projects,workspace.value.resources||[]);
        await workspace.save({...workspace.value,resources:[...(workspace.value.resources||[]).filter(item=>item.id!==resource.id),resource]});catalog.invalidate();publishWorkspace();return {resource,workspace:workspace.view(),catalog:await getCatalog()};
      }
      if(method==='resourcePause'){
        if(typeof args.paused!=='boolean'||!(workspace.value.resources||[]).some(item=>item.id===args.id))throw new Error('资源不存在');
        await workspace.save({...workspace.value,resources:workspace.value.resources.map(item=>item.id===args.id?{...item,paused:args.paused,updatedAt:nowIso()}:item)});catalog.invalidate();publishWorkspace();return {workspace:workspace.view(),catalog:await getCatalog()};
      }
      if(method==='workspaceExport'){
        const directory=path.join(dataDirectory,'exports');await fs.mkdir(directory,{recursive:true});const file=path.join(directory,`workflow-configuration-${Date.now()}.json`);const bytes=JSON.stringify({schema:'workflow-configuration-export/1',exportedAt:nowIso(),config,workspace:workspace.view()},null,2);await fs.writeFile(file,bytes,{flag:'wx'});return {path:file};
      }
      if(method==='managerOpen'){
        if(process.platform!=='win32'||path.basename(config.managerApp||'').toLocaleLowerCase()!=='skills-manager.exe'||!(await fs.stat(config.managerApp)).isFile())throw new Error('Skills Manager 程序路径不可用，请在关联页核对');
        return new Promise((resolve,reject)=>{const child=spawn(config.managerApp,[],{shell:false,windowsHide:false,detached:true,stdio:'ignore'});child.once('spawn',()=>{child.unref();resolve({requested:true});});child.once('error',reject);});
      }
      if (method === 'openData') return openFolder(dataDirectory);
      if(method==='openThread'){
        const task=current?.snapshot?.projects.flatMap(p=>p.tasks||[]).find(t=>t.id===args.id);
        if(!task||!/^[a-f0-9-]{36}$/.test(task.threadId))throw new Error('聊天尚未关联');
        if(process.platform!=='win32')throw new Error('请使用原聊天链接');
        return new Promise((resolve,reject)=>{const child=spawn('explorer.exe',[`codex://threads/${task.threadId}`],{shell:false,windowsHide:true,stdio:'ignore'});child.once('spawn',()=>resolve({opened:true}));child.once('error',reject);});
      }
      if(method==='openTaskProject'){
        const task=current?.snapshot?.projects.flatMap(p=>p.tasks||[]).find(t=>t.id===args.id);
        if(!task)throw new Error('任务尚未关联');return openFolder(task.projectRoot);
      }
      if (method === 'openProject') {
        const project = current?.snapshot?.projects.find(p => p.id === args.id);
        if (!project?.root) throw new Error('尚未关联工程');
        return openFolder(project.root);
      }
      if (method === 'openSource') {
        const project = current?.snapshot?.projects.find(p => p.id === args.id);
        const source = project?.sources?.[Number(args.index)];
        if (!source) throw new Error('来源不存在');
        return openFolder(source.path);
      }
      if (method === 'configure') {
        if (args.expectedRevision !== revision) throw new Error('配置已更新，请重新打开设置');
        const validated = await validateConfig(args.values);
        if (canonical(validated) !== canonical(config)) {
          const next = {schema: 'workflow-config/1', revision: revision + 1, values: validated};
          const temp = `${configFile}.pending-${process.pid}`;
          await fs.writeFile(temp, JSON.stringify(next, null, 2), {flag: 'wx'});
          await fs.rename(temp, configFile); config = validated; revision = next.revision; catalog.invalidate();
          return refresh('configuration');
        }
        return current;
      }
      throw new Error('不支持的操作');
    });},
    async dispose() {closed = true; clearInterval(timer); await pending;}
  };
};
