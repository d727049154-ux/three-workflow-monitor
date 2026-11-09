import {createCatalogPanel} from './catalog-ui.mjs';
import {createQuickPanel} from './quick-ui.mjs';
import {createActivityPanel} from './activity-ui.mjs';
import {createWorkflowEditor} from './workflows-ui.mjs';
import {createResourceEditor} from './resources-ui.mjs';
const make = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
};
const formatTime = (date, full = false) => date ? new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(full ? {second: '2-digit'} : {}), hour12: false}).format(new Date(date)) : '未登记';
const reasons = {change: '状态变化', checkpoint: '手动留档', configuration: '关联配置变更'};
const displayText=value=>String(value||'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/\*\*|`/g,'');
export function activate(ctx) {
  return {
    mount(container, initialContext) {
      let disposed = false, context = initialContext, latest = null, mode = 'live', selected = null, history = null, message = '', busy = false, off = null;
      let calls=Promise.resolve(),returnMode='live',pendingFocus=null,pendingTarget=null,liveFilter='all',refreshingAll=false,lastManualRefresh=null;
      const expanded = new Set();
      const taskStages=new Map(),taskExpanded=new Set(),allItems=new Set();
      const root = make('section', 'wm');
      root.setAttribute('aria-label', '工作流进度、技能与历史');
      container.append(root);
      const button = (text, action, className = '', title = '') => {
        const node = make('button', `wm-button ${className}`, text);
        node.type = 'button'; if (title) node.title = title;
        node.addEventListener('click', action); return node;
      };
      const call = (method, args, callback) => {
        const job=calls.then(async()=>{
        if (disposed) return false;
        busy = true; root.setAttribute('aria-busy', 'true');
        try {const value = await ctx.backend.call(method, args || {}); if (!disposed) await callback?.(value);}
        catch (error) {message = error.message || String(error);}
        finally {busy = false; if (!disposed) {root.removeAttribute('aria-busy'); render();}}
        return true;});calls=job.catch(()=>{});return job;
      };
      const announce=text=>{message=text;};
      const quick=createQuickPanel({make,button,call,render,announce,onNavigate:navigateTarget,onClose:()=>{mode=returnMode;pendingFocus='quick:trigger';render();},loadCatalog:()=>catalog.load(false)});
      const catalog = createCatalogPanel({make, button, call, render, formatTime, announce,quick,onData:value=>quick.setCatalog(value),getFlows:()=>quick.state().workflows||[],onAddResource:()=>editResource(),onEditResource:id=>editResource(quick.state().resources.find(item=>item.id===id)),onProgress: flow => {mode = 'live';liveFilter=flow;taskStages.set(flow, 'all');pendingTarget={kind:'workflow',id:flow};render();}});
      const editor=createWorkflowEditor({make,button,call,render,announce,getWorkspace:()=>quick.state(),getCatalog:()=>catalog.peek(),loadCatalog:()=>catalog.load(false),onCancel:()=>{mode='live';render();},onSaved:result=>{latest=result.view;quick.setWorkspace(latest.workspace);quick.setSnapshot(latest.snapshot);catalog.invalidate();mode='live';liveFilter=result.flow.id;taskStages.set(result.flow.id,'all');pendingTarget={kind:'workflow',id:result.flow.id};render();}});
      const resourceEditor=createResourceEditor({make,button,call,render,announce,getWorkspace:()=>quick.state(),getCatalog:()=>catalog.peek(),getProjects:()=>[...(latest?.snapshot?.projects||[]),...(quick.state().workflows||[]).filter(flow=>flow.paused)],loadCatalog:()=>catalog.load(false),onCancel:()=>{mode='catalog';catalog.showResources();render();},onSaved:value=>{quick.setWorkspace(value.workspace);catalog.accept(value.catalog);catalog.focusTarget({kind:'resource',id:value.resource.id});mode='catalog';pendingTarget={kind:'resource',id:value.resource.id};render();}});
      const activity=createActivityPanel({make,button,call,render,formatTime,getWorkspace:()=>quick.state(),setWorkspace:value=>quick.setWorkspace(value),getSnapshot:()=>latest?.snapshot,onSnapshot:showChangeSnapshot,onTask:id=>quick.navigate({kind:'task',id}),onBack:()=>{mode='live';render();}});
      async function refreshAll(){
        if(refreshingAll)return;refreshingAll=true;render();
        try{await call('refreshAll',{},value=>{
          receive(value.view);catalog.accept(value.catalog);history=value.history;lastManualRefresh=new Date().toISOString();
          const issues=[value.view.error,!value.catalog.manager?.connected&&'Skills Manager 连接待核对'].filter(Boolean);
          announce(issues.length?`刷新完成，部分来源需检查：${issues.join('；')}`:`已刷新任务、${value.catalog.stats.skills} 个 Skill、${value.catalog.stats.availableResources} 个资源集合及 Skills Manager。`);
          if(mode==='changes')activity.open();
        });}finally{refreshingAll=false;render();}
      }
      function newWorkflow(flow){mode='workflow';editor.open(flow);pendingFocus='workflow:title';render();}
      function editResource(resource){mode='resource';resourceEditor.open(resource);pendingFocus='resource:title';render();}
      function showQuick(){if(mode!=='search')returnMode=mode;mode='search';quick.open();pendingFocus='quick:query';render();}
      function showChanges(){mode='changes';render();activity.open();}
      function navigateTarget(target){
        if(['workflow','task','item'].includes(target.kind)){
          const taskId=target.kind==='item'?target.parentId:target.id;const project=latest?.snapshot?.projects.find(p=>target.kind==='workflow'?p.id===target.id:p.tasks?.some(t=>t.id===taskId));if(!project)return false;
          mode='live';liveFilter=project.id;selected=null;taskStages.set(project.id,'all');if(target.kind!=='workflow'){taskExpanded.add(`live:${taskId}`);if(target.kind==='item')allItems.add(`live:${taskId}`);}
          pendingTarget=target;
        }else{if(!catalog.focusTarget(target))return false;mode='catalog';pendingTarget=target;}
        render();return true;
      }
      async function showChangeSnapshot(event){
        await call('snapshot',{id:event.snapshotId},value=>{selected=value;mode='history';if(event.workflow)taskStages.set(event.workflow,'all');if(event.taskId)taskExpanded.add(`past:${event.taskId}`);pendingTarget={kind:event.taskId?'task':'workflow',id:event.taskId||event.workflow};});
        if(!history)await call('history',{},value=>{history=value;});
      }
      root.addEventListener('keydown',event=>{if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.isComposing&&!event.target.closest('input,textarea,select,[contenteditable="true"]')){event.preventDefault();showQuick();}});
      function showCatalog(flow) {mode = 'catalog'; selected = null; catalog.open(flow); render();}
      function receive(value) {if (value?.schema !== 'workflow-view/1' || disposed) return; const first=!latest,changed=latest&&value.configRevision!==latest.configRevision,flowsChanged=latest&&JSON.stringify([latest.workspace?.workflows,latest.workspace?.resources])!==JSON.stringify([value.workspace?.workflows,value.workspace?.resources]);if(changed||flowsChanged)catalog.invalidate();latest=value;quick.setSnapshot(value.snapshot);quick.setWorkspace(value.workspace);if(first||changed||(!['settings','catalog','search','workflow','resource'].includes(mode)))render();}
      function renderTasks(project,past){
        const chosen=taskStages.get(project.id)||'all';
        const stage=project.workflow?.stages.find(s=>s.id===chosen);
        const tasks=(project.tasks||[]).filter(task=>chosen==='all'||task.stages.includes(chosen));
        const panel=make('section','wm-linked-panel');panel.setAttribute('aria-label',`${project.title}关联任务`);
        const heading=make('div','wm-linked-heading');heading.append(make('strong','',`${stage?.label||'全部环节'} · ${tasks.length} 个任务`));
        if(chosen!=='all')heading.append(button('查看全部',()=>{taskStages.set(project.id,'all');render();},'wm-text-button'));
        panel.append(heading,make('p','wm-linked-note','任务可跨多个环节。点击任务展开最近进展、具体小项和来源。'));
        if(!tasks.length){panel.append(make('p','wm-empty',past?'这份旧快照尚未记录关联小任务，原流程与来源仍保留。':'这个环节还没有关联任务；“已定义”只代表流程规范。'));return panel;}
        const list=make('div','wm-linked-list');list.dataset.scrollKey=`${past?'past':'live'}:${project.id}:${chosen}`;
        for(const task of tasks){
          const key=`${past?'past':'live'}:${task.id}`;
          const entry=make('article','wm-linked-task');entry.dataset.taskId=task.id;
          const activity=!past?latest?.liveTasks?.find(item=>item.id===task.id):null;
          const stateLabel=activity?.label||task.reportedLabel||({inProgress:'当时回合未结束',completed:'回合已结束',failed:'聊天异常',interrupted:'聊天已中断',unavailable:'来源不可读'}[task.session?.status]||'已有进展记录');
          const toggle=button('',()=>{taskExpanded.has(key)?taskExpanded.delete(key):taskExpanded.add(key);if(!past&&taskExpanded.has(key))quick.visit({kind:'task',id:task.id});render();},'wm-task-toggle');
          toggle.setAttribute('aria-expanded',String(taskExpanded.has(key)));toggle.setAttribute('aria-label',`${task.title} · ${taskExpanded.has(key)?'收起':'展开'}小任务`);
          toggle.dataset.focusKey=`task:${key}`;
          toggle.append(make('span','wm-task-name',task.title),make('span',`wm-task-activity ${activity?.active?'is-updating':''}`,stateLabel),make('span','wm-disclosure',taskExpanded.has(key)?'−':'+'));
          const taskHead=make('div','wm-entry-heading');taskHead.append(toggle);if(!past)taskHead.append(quick.favoriteButton({kind:'task',id:task.id},task.title));entry.append(taskHead,make('p','wm-task-focus',task.focus));
          const current=displayText(task.priorityNote||task.latestText);
          entry.append(make('p',`wm-task-excerpt ${task.priorityNote?'wm-issue':''}`,current.length>150?`${current.slice(0,150)}…`:current));
          entry.append(make('p','wm-task-meta',`进展来源 ${formatTime(task.priorityAt||task.updatedAt,true)}${task.session?.status==='completed'?' · 回合结束不代表整体验收':''}`));
          if(taskExpanded.has(key)){
            const details=make('div','wm-linked-detail');
            const items=(task.items||[]).filter(item=>chosen==='all'||item.stages.includes(chosen));
            if(items.length){
              details.append(make('h4','',`已记录的小项 · ${items.length}`));
              for(const item of allItems.has(key)?items:items.slice(0,4)){
                const row=make('div','wm-work-item');row.dataset.itemId=item.id;row.append(make('strong','',item.title),make('span','wm-item-state',item.stateLabel),make('p','',displayText(item.detail)),make('small','',`来源更新 ${formatTime(item.updatedAt)}`));details.append(row);
              }
              if(items.length>4)details.append(button(allItems.has(key)?'收起小项':`展开全部 ${items.length} 项`,()=>{allItems.has(key)?allItems.delete(key):allItems.add(key);render();},'wm-text-button'));
            }
            if(task.messages?.length)details.append(make('h4','',task.priorityNote?'较早的聊天进展 · 队列以较新记录为准':'最近文字进展'));
            for(const update of (task.messages||[]).slice(-5).reverse()){
              const line=make('div','wm-task-update');line.append(make('small','',`${update.at?formatTime(update.at,true):'关联时读取'} · ${update.phase==='commentary'?'进展说明':'回合回复'}`),make('p','',displayText(update.text)));details.append(line);
            }
            for(const issue of task.issues||[])details.append(make('p','wm-issue',issue));
            const actions=make('div','wm-task-actions');
            if(!past){if(task.threadId)actions.append(button('打开原聊天',()=>call('openThread',{id:task.id}),'wm-secondary'));actions.append(button('打开任务目录',()=>call('openTaskProject',{id:task.id}),'wm-text-button'),button('本流程的技能与资源',()=>showCatalog(project.id),'wm-text-button'));}
            details.append(actions,make('p','wm-linked-note',`环节归属核对于 ${formatTime(task.linkedAt)}。进展为来源记录，制作与视觉验收以具体小项为准。`));
            const proof=make('div','wm-task-proof');
            for(const source of task.sources||[]){proof.append(make('span','',source.role),make('code','',source.path),make('small','',`${source.scope} · ${source.sha256.slice(0,12)}…`));}
            details.append(proof);entry.append(details);
          }
          list.append(entry);
        }
        panel.append(list);return panel;
      }
      function renderCard(project, past = false) {
        const card = make('article', `wm-card wm-state-${project.state}`);
        card.dataset.workflowId=project.id;
        const top = make('div', 'wm-card-top');
        top.append(make('span', 'wm-pip'), make('h3', '', project.title));if(!past)top.append(quick.favoriteButton({kind:'workflow',id:project.id},project.title));
        card.append(top);
        if (project.workflow) {
          const wf = project.workflow;
          card.append(make('p', 'wm-workflow-state', wf.stateLabel));
          const stages = make('div', 'wm-stage-grid');
          for (const stage of wf.stages) {
            const interactive=typeof stage.id==='string'&&Array.isArray(project.tasks);
            const selected=interactive&&taskStages.get(project.id)===stage.id;
            const row = button('',()=>{selected?taskStages.delete(project.id):taskStages.set(project.id,stage.id);render();},`wm-stage wm-stage-${stage.state}${selected?' is-selected':''}`);
            row.setAttribute('aria-label',`${project.title} · ${stage.label} · ${stage.taskCount||0} 个任务`);row.setAttribute('aria-expanded',String(selected));
            row.dataset.focusKey=`stage:${project.id}:${stage.id}`;
            row.disabled=!interactive;
            row.append(make('span', '', stage.label), make('small', '', stage.stateLabel),make('span','wm-stage-count',interactive?`${stage.taskCount||0} 个任务 ›`:'当时未接小任务')); stages.append(row);
          }
          card.append(stages);
          if(project.custom)card.append(make('p','wm-custom-state',`${project.stateLabel} · ${project.phase}${project.progress?` · ${project.progress.completed}/${project.progress.total} ${project.progress.unit}`:''}`));
          const meta = make('div', 'wm-card-meta'); meta.append(make('span', '', `建设依据 ${formatTime(wf.updatedAt)}`));
          const toggle = button(expanded.has(project.id) ? '收起流程依据' : '流程依据与原入口', () => {expanded.has(project.id) ? expanded.delete(project.id) : expanded.add(project.id); render();}, 'wm-text-button');
          toggle.setAttribute('aria-expanded', String(expanded.has(project.id))); meta.append(toggle);
          if(!past)meta.append(button('技能与资源',()=>showCatalog(project.id),'wm-text-button'));
          meta.append(button(`全部任务 · ${project.tasks?.length||0}`,()=>{taskStages.has(project.id)?taskStages.delete(project.id):taskStages.set(project.id,'all');render();},'wm-text-button'));
          if(project.custom&&!past)meta.append(button('编辑流程',()=>newWorkflow(quick.state().workflows.find(flow=>flow.id===project.id)),'wm-text-button'));
          card.append(meta);
          if(taskStages.has(project.id)||expanded.has(project.id))card.append(renderTasks(project,past));
          if (!expanded.has(project.id)) return card;
          card.append(make('p', 'wm-workflow-summary', wf.summary), make('p', 'wm-workflow-note', wf.note));
          const taskTitle = make('div', 'wm-task-title'); taskTitle.append(make('strong', '', '当前执行记录'), make('span', 'wm-status', project.stateLabel)); card.append(taskTitle);
        } else top.append(make('span', 'wm-status', project.stateLabel));
        card.append(make('p', 'wm-project', project.project));
        card.append(make('p', 'wm-phase', project.phase));
        if (project.progress) {
          const p = project.progress;
          const meta = make('div', 'wm-progress-label'); meta.append(make('span', '', p.label), make('strong', '', `${p.completed} / ${p.total} ${p.unit}`));
          const track = make('div', 'wm-track'); track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', p.label); track.setAttribute('aria-valuenow', String(p.completed)); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(p.total));
          const fill = make('span'); fill.style.width = `${p.completed / p.total * 100}%`; track.append(fill); card.append(meta, track);
        }
        if (project.facts.length) card.append(make('p', 'wm-fact', project.facts[0]));
        if (project.state === 'unconfigured') {
          card.append(button('关联工程目录', () => {mode = 'settings'; render();}, 'wm-text-button'));
        } else if (!project.workflow) {
          const meta = make('div', 'wm-card-meta');
          meta.append(make('span', '', `来源更新 ${formatTime(project.updatedAt)}`));
          const disclosure = button(expanded.has(project.id) ? '收起' : '详情与来源', () => {expanded.has(project.id) ? expanded.delete(project.id) : expanded.add(project.id); render();}, 'wm-text-button');
          disclosure.setAttribute('aria-expanded', String(expanded.has(project.id))); meta.append(disclosure); card.append(meta);
        }
        if (expanded.has(project.id)) {
          const detail = make('div', 'wm-details');
          if (project.summary) detail.append(make('p', 'wm-muted', project.summary));
          for (const fact of project.facts.slice(1)) detail.append(make('p', 'wm-fact', fact));
          for (const issue of project.issues) detail.append(make('p', 'wm-issue', issue));
          if (project.activities.length) {
            detail.append(make('h4', '', '源文件中的最近事件'));
            for (const activity of project.activities) detail.append(make('p', 'wm-event', `${formatTime(activity.time)}  ${activity.label}`));
          }
          detail.append(make('h4', '', '状态依据'));
          project.sources.forEach((source, index) => {
            const line = make('div', 'wm-source');
            line.append(make('strong', '', source.role), make('code', '', source.path), make('small', '', `SHA256 ${source.sha256.slice(0, 16)}… · ${source.scope}`));
            if (!past) line.append(button('定位文件', () => call('openSource', {id: project.id, index}), 'wm-text-button'));
            detail.append(line);
          });
          if (!past && project.root) detail.append(button('打开工程目录', () => call('openProject', {id: project.id}), 'wm-secondary'));
          card.append(detail);
        }
        return card;
      }
      function renderSettings(body) {
        body.append(make('p', 'wm-intro', '上层观察流程建设，环节内关联正在推进的小任务。汽车任务目录可以留空，聊天与报告通过任务清单关联。'));
        const form = make('form', 'wm-form');
        const inputs = {};
        editor.appendManagement(body,newWorkflow,receive);
        resourceEditor.appendManagement(body,editResource,value=>{quick.setWorkspace(value.workspace);catalog.accept(value.catalog);render();});
        for (const [key, label] of [['eagleRoot', 'Eagle 流程记录目录'], ['whiteRoot', '白模流程记录目录'], ['whiteRun', '白模当前运行入口（runs 下的目录名）'], ['carFlowRoot', '汽车流程 Skill 目录'], ['carRoot', '汽车当前任务目录（选填）'],['taskLinksFile','小任务关联清单（JSON）'],['codexSessionsRoot','Codex 会话记录目录'],['catalogFile','技能与资源关联清单（JSON）'],['managerRoot','Skills Manager 数据目录'],['managerApp','Skills Manager 程序']]) {
          const field = make('label', 'wm-field'); field.append(make('span', '', label));
          const input = make('input'); input.type = 'text'; input.name = key; input.value = latest?.config?.[key] || ''; input.autocomplete = 'off'; input.spellcheck = false; field.append(input); inputs[key] = input; form.append(field);
        }
        form.append(make('p', 'wm-muted', '汽车项目使用 workflow-progress.json。未提供进度记录时会显示“待接入”，不会估算百分比。'));
        const save = make('button', 'wm-button wm-primary', '保存关联'); save.type = 'submit'; form.append(save);
        form.addEventListener('submit', event => {event.preventDefault(); call('configure', {expectedRevision: latest?.configRevision, values: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]))}, value => {latest = value; mode = 'live'; selected = null; message = '关联已保存，旧配置随历史快照保留。';});});
        body.append(form);
        const connections=make('div','wm-connection-list');connections.append(make('h4','','已关联的任务'));
        for(const project of latest?.snapshot?.projects||[])for(const task of project.tasks||[])connections.append(make('p','wm-muted',`${project.title} · ${task.title}`));
        connections.append(make('p','wm-muted','内置工作流沿用任务关联清单；自定义工作流可按工程每 60 秒发现新增聊天。已关联任务每 15 秒读取进展；具体环节归属以清单或进度文件为准。'));body.append(connections);
        const storage = make('div', 'wm-storage'); storage.append(make('h4', '', '本机回溯记录'), make('code', '', latest?.dataDirectory || '等待后端启动'));
        storage.append(button('打开记录目录', () => call('openData'), 'wm-secondary'));
        storage.append(button('导出流程与收藏配置',()=>call('workspaceExport',{},value=>announce(`配置已导出：${value.path}`)),'wm-secondary'));
        storage.append(make('p', 'wm-muted', '暂停观察：本机预览运行“停止预览.cmd”；安装后可在 Token Monitor 插件设置中停用“工作流观察”。历史和自定义配置继续保留。'));
        body.append(storage);
      }
      function renderHistory(body) {
        const controls = make('div', 'wm-history-tools');
        controls.append(button('校验记录', () => call('verify', {}, result => {message = `已校验 ${result.snapshots} 份快照、${result.sources} 份来源副本。`; }), 'wm-secondary'));
        controls.append(button('导出回溯', () => call('export', {}, result => {message = `已导出至 ${result.path}`;}), 'wm-secondary'));
        body.append(controls, make('p', 'wm-muted', '回溯从首次观察开始。查看旧快照只切换显示，不恢复或改动制作文件。'));
        if (!history) {body.append(make('p', 'wm-loading', '正在读取历史…')); return;}
        if (!history.entries.length) body.append(make('p', 'wm-empty', '还没有历史，首次成功读取后会自动留档。'));
        const list = make('div', 'wm-history-list');
        for (const record of history.entries) {
          const item = button('', () => call('snapshot', {id: record.id}, value => {selected = value;}), `wm-history-item ${selected?.id === record.id ? 'is-selected' : ''}`);
          item.append(make('span', 'wm-history-time', `#${record.id}  ${formatTime(record.observedAt, true)}`), make('span', 'wm-history-kind', reasons[record.reason] || record.reason), make('small', '', record.summary)); list.append(item);
        }
        body.append(list);
        if (history.nextBefore > 1) body.append(button('更早的记录', () => call('history', {before: history.nextBefore}, data => {history = {...data, entries: [...history.entries, ...data.entries]};}), 'wm-secondary'));
        if (selected) {
          const banner = make('div', 'wm-past-banner'); banner.append(make('strong', '', `正在查看 #${selected.id}`), make('span', '', `观察于 ${formatTime(selected.observedAt, true)}`)); body.append(banner);
          for (const project of selected.projects) body.append(renderCard(project, true));
          body.append(make('code', 'wm-hash', `快照 SHA256 ${selected.hash}`));
        }
      }
      function render() {
        if (disposed) return;
        const scrolls=new Map([...root.querySelectorAll('[data-scroll-key]')].map(el=>[el.dataset.scrollKey,el.scrollTop]));
        const active=document.activeElement;const focusKey=root.contains(active)?active?.dataset?.focusKey:null;
        const selection=focusKey&&typeof active.selectionStart==='number'?{start:active.selectionStart,end:active.selectionEnd}:null;
        const compact = context?.surface === 'edgeDock' && (/rail|compact/.test(context?.surfaceVariant || '') || (context?.width && context.width < 130));
        root.classList.toggle('wm-compact', !!compact);
        root.replaceChildren();
        if (compact) {
          root.append(make('span', 'wm-compact-icon', '流'), make('strong', '', `${latest?.snapshot?.projects.length || 0}`));
          root.title = '工作流观察 · 展开查看项目与回溯'; return;
        }
        const head = make('header', 'wm-header');
        const brand = make('div', 'wm-brand'); brand.append(make('span', 'wm-mark', '流'), make('h2', '', '工作流观察'));
        const headActions=make('div','wm-header-actions');const refreshButton=button(refreshingAll?'刷新中…':'刷新',refreshAll,'wm-refresh wm-secondary','立即更新工作流、任务、Skill、资源与 Skills Manager');refreshButton.disabled=refreshingAll;refreshButton.dataset.focusKey='refresh:all';headActions.append(refreshButton,make('span','wm-refresh-time',refreshingAll?'正在读取本机来源':lastManualRefresh?`${formatTime(lastManualRefresh,true)} 已刷新`:'立即更新全部'));head.append(brand,headActions);
        root.append(head);
        const nav = make('nav', 'wm-nav'); nav.setAttribute('aria-label', '查看方式');
        for (const [key, label] of [['live', '实时'], ['catalog', '技能与资源'], ['history', '回溯'], ['settings', '关联']]) {
          const el = button(label, () => {mode = key; selected = null; render(); if (key === 'history') call('history', {}, data => {history = data;}); if(key==='catalog')catalog.open();}, key === mode ? 'is-active' : ''); el.setAttribute('aria-pressed', String(mode === key)); nav.append(el);
        }
        root.append(nav);
        if(mode!=='search'){const search=button('',showQuick,'wm-search-trigger');search.dataset.focusKey='quick:trigger';search.append(make('span','','搜索任务、技能、资源与动作'),make('kbd','','/'));root.append(search);}
        const body = make('div', 'wm-body');
        if (!latest) body.append(make('div', 'wm-loading', '正在连接本机项目记录…'));
        else {
          if (latest.error) body.append(make('p', 'wm-error', latest.error));
          if (mode === 'search')quick.append(body);
          else if(mode==='workflow')editor.append(body);
          else if(mode==='resource')resourceEditor.append(body);
          else if(mode==='changes')activity.append(body);
          else if (mode === 'catalog') {catalog.append(body); catalog.open();}
          else if (mode === 'settings') renderSettings(body);
          else if (mode === 'history') renderHistory(body);
          else {
            if (latest.snapshot) {
              const overview = make('div', 'wm-overview');
              const projects = latest.snapshot.projects;
              for (const [value, label] of [[`${projects.filter(p => p.workflow?.defined).length} / ${projects.length}`, '流程已识别'], [projects.reduce((n,p)=>n+(p.tasks?.length||0),0), '关联任务'], [latest.totalSnapshots, '历史快照']]) {
                const metric = make('div'); metric.append(make('strong', '', String(value)), make('span', '', label)); overview.append(metric);
              }
              body.append(overview,make('p','wm-open-hint','点环节看任务，再点任务看细节与最近进展。'));
              quick.appendHome(body,showQuick,showChanges,()=>newWorkflow());
              if(liveFilter!=='all'&&!projects.some(project=>project.id===liveFilter))liveFilter='all';
              const filter=make('label','wm-catalog-select wm-flow-filter');filter.append(make('span','wm-sr-only','查看工作流'));const select=make('select');select.setAttribute('aria-label','查看工作流');select.dataset.focusKey='live:filter';for(const [id,title] of [['all','全部工作流'],...projects.map(project=>[project.id,project.title])]){const option=make('option','',title);option.value=id;option.selected=id===liveFilter;select.append(option);}select.addEventListener('change',()=>{liveFilter=select.value;render();});filter.append(select);body.append(filter);
              for (const project of projects.filter(project=>liveFilter==='all'||project.id===liveFilter)) body.append(renderCard(project));
              const save = make('div', 'wm-save-row'); save.append(make('span', '', `当前留档 #${latest.snapshot.id}`), button('留一份快照', () => call('checkpoint', {}, value => {latest = value; message = `已保留快照 #${value.snapshot?.id}。`; }), 'wm-secondary')); body.append(save);
            } else body.append(make('p', 'wm-empty', '还未取得可用的项目记录。请检查关联目录。'));
          }
        }
        root.append(body);
        if (message) {const toast = make('p', 'wm-message', message); toast.setAttribute('role', 'status'); root.append(toast);}
        root.append(make('footer', 'wm-footer', mode==='catalog'?`v0.5.0 · 60 秒同步目录${catalog.scannedAt()?` · ${formatTime(catalog.scannedAt(),true)}`:''}`:`v0.5.0 · 15 秒读取进展${latest ? ` · ${formatTime(latest.checkedAt, true)}` : ''}`));
        for(const node of root.querySelectorAll('[data-scroll-key]'))if(scrolls.has(node.dataset.scrollKey))node.scrollTop=scrolls.get(node.dataset.scrollKey);
        if(focusKey){const next=[...root.querySelectorAll('[data-focus-key]')].find(node=>node.dataset.focusKey===focusKey);next?.focus({preventScroll:true});if(selection&&next?.setSelectionRange)next.setSelectionRange(selection.start,selection.end);}
        if(pendingFocus){const node=[...root.querySelectorAll('[data-focus-key]')].find(node=>node.dataset.focusKey===pendingFocus);if(node){node.focus({preventScroll:true});pendingFocus=null;}}
        if(pendingTarget){const t=pendingTarget;const field=t.kind==='workflow'?'workflowId':t.kind==='task'?'taskId':t.kind==='item'?'itemId':['motion','pose','file'].includes(t.kind)?'partId':'catalogId';const id=field==='catalogId'?(t.parentId||t.id):t.id;const node=[...root.querySelectorAll('[data-workflow-id],[data-task-id],[data-item-id],[data-catalog-id],[data-part-id]')].find(node=>node.dataset[field]===id&&(t.kind!=='item'||node.closest('[data-task-id]')?.dataset.taskId===t.parentId)&&(!['motion','pose','file'].includes(t.kind)||node.closest('[data-catalog-id]')?.dataset.catalogId===t.parentId));if(node){node.scrollIntoView({block:'nearest'});const action=node.matches('button')?node:node.querySelector('button');action?.focus({preventScroll:true});pendingTarget=null;}}
        if(mode==='search')quick.afterRender(root);
      }
      render();
      try {off = ctx.backend.subscribe(receive);} catch (error) {message = error.message;}
      ctx.backend.call('current').then(receive).catch(error => {if (!disposed) {message = `连接失败：${error.message}`; render();}});
      const catalogTimer=setInterval(()=>{if(!disposed&&mode==='catalog')catalog.load('auto');},60000);
      return {
        update(next) {context = next; if (next?.data?.schema === 'workflow-view/1') receive(next.data); else if (!['settings','catalog','workflow','resource','search'].includes(mode)) render();},
        dispose() {disposed = true;clearInterval(catalogTimer);if (typeof off === 'function') off(); root.remove();}
      };
    }
  };
}
