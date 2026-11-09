const bridge = window.workflowApp;
const byId = id => document.getElementById(id);
const element = (tag, className, text) => {const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value;};
let view, state={}, selected=null, mode='task', historical=null, refreshing=false, entries=[], nextBefore=null, historyTotal=0, historyRequest=0, detailKey='';
const seen=new Map();
function date(value, full=false) {const when=new Date(value);return value&&Number.isFinite(when.getTime())?when.toLocaleString('zh-CN',full?{hour12:false}:{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'时间未登记';}
function notify(message) {byId('notice').textContent=message||'';byId('notice').hidden=!message;}
function shortTitle(title) {return title.replace(/^(继续|调研|修复|优化|制作|关于|帮我|请)+/,'').slice(0,13)||title.slice(0,13);}
function currentTask() {return (historical?.projects?.[0]?.tasks||view?.tasks||[]).find(task=>task.id===selected);}
async function showArtifacts(container, taskId) {
  try {
    const artifacts = await bridge.call('dockArtifacts', {id:taskId});
    if (!container.isConnected) return;
    const makeRow = artifact => {
      const button = element('button','history-entry');
      button.type = 'button';
      button.append(element('strong','',artifact.label),element('small','',(artifact.kind === 'video' ? '播放视频' : '定位文件')+' · '+date(artifact.at,true)));
      button.addEventListener('click', async () => {
        try { await bridge.call('dockOpenArtifact', {id:taskId,artifactId:artifact.id}); }
        catch (error) { notify(error.message); }
      });
      return button;
    };
    if (!artifacts.length) {
      container.replaceChildren(element('p','hint','这条聊天暂无可访问的本机产出。'));
      return;
    }
    const more = element('button','history-entry','显示更多');
    more.type = 'button';
    let shown = 0;
    function appendPage() {
      more.before(...artifacts.slice(shown, shown + 20).map(makeRow));
      shown += 20;
      more.hidden = shown >= artifacts.length;
    }
    more.addEventListener('click', appendPage);
    container.replaceChildren(element('p','hint',artifacts.length+' 条文件记录'), more);
    appendPage();
  } catch (error) {
    container.replaceChildren(element('p','hint',error.message));
  }
}
function applyState(value) {
  state=value;byId('dock').dataset.side=value.dock?.side||'left';
  byId('detail').hidden=!value.dock?.expanded;
  const pin = byId('pin');
  pin.setAttribute('aria-pressed', String(value.alwaysOnTop));
  pin.textContent = value.alwaysOnTop ? '已置顶' : '置顶';
  pin.title = value.alwaysOnTop ? '点击取消置顶' : '点击开启置顶';
  pin.disabled = false;
}
async function command(name) {try {applyState(await bridge.command(name));}catch(issue){notify(issue.message);}}
function receive(value) {
  if(!value)return;
  const old=view;view=value;
  byId('task-count').textContent=String(value.tasks?.length||0);
  byId('rail-time').textContent=value.checkedAt?date(value.checkedAt):'正在连接';
  byId('rail-error').hidden=!value.error&&!value.unreadable;
  byId('rail-error').textContent=value.error?'读取待恢复':value.unreadable?'部分来源待同步':'';
  byId('rail-error').title=value.error||'暂不可读的任务保留上次进展';
  renderList();
  if(mode==='task'&&!historical&&selected) {
    if(!currentTask()) {
      const ended=value.finished?.find(task=>task.id===selected),previous=old?.tasks?.find(task=>task.id===selected);
      if(ended||previous) {historical={id:old?.historyId,observedAt:old?.checkedAt,projects:[{tasks:[ended||previous]}]};notify(ended?'本回合已结束或中断；最后记录已保留。成果验收请查看原聊天。':'该任务已不在当前列表，保留上次进展供查看。');}
    }
    renderDetail();
  }
}
function renderList() {
  const list=byId('task-list'),scroll=list.scrollTop,focused=list.contains(document.activeElement)?document.activeElement?.dataset.id:null;
  const fragment=document.createDocumentFragment();
  for(const task of view?.tasks||[]) {
    const button=element('button','task-button');button.type='button';button.dataset.id=task.id;
    button.setAttribute('aria-label',task.title+'，'+task.stateLabel+(task.progress?'，'+task.progress.percent+'%':''));
    button.setAttribute('aria-pressed',String(mode==='task'&&selected===task.id&&!historical));button.title=task.title+'\n'+task.stateLabel+'\n'+(task.latestText||'').slice(0,220);
    if(seen.has(task.id)&&seen.get(task.id)!==task.updatedAt)button.classList.add('new-progress');
    const ring=element('span','task-ring '+task.state);
    if(task.progress) {ring.classList.add('quantified');ring.style.setProperty('--progress',task.progress.percent+'%');ring.append(element('span','',task.progress.percent+'%'));}
    else {ring.append(element('span','',shortTitle(task.title).slice(0,2)),element('b'));}
    button.append(ring,element('span','task-title',shortTitle(task.title)),element('span','task-status',task.progressStale&&task.progress?'上次 '+task.stateLabel:task.stateLabel));
    button.addEventListener('click',()=>selectTask(task.id));fragment.append(button);
  }
  if(!view?.tasks?.length)fragment.append(element('p','rail-empty',view?.checkedAt?'暂无活动任务\n新任务会自动出现':'正在读取\n本机任务…'));
  list.replaceChildren(fragment);list.scrollTop=scroll;
  if(focused) [...list.children].find(button=>button.dataset.id===focused)?.focus({preventScroll:true});
}
async function selectTask(id, snapshot=null) {
  selected=id;historical=snapshot;mode='task';detailKey='';
  const task=currentTask();if(task)seen.set(task.id,task.updatedAt);
  notify(snapshot?'正在查看历史快照 #'+snapshot.id+' · '+date(snapshot.observedAt,true):view?.error||'');
  renderList();renderDetail();await command('dockExpand');
}
function renderDetail() {
  if(mode!=='task')return;
  const task=currentTask();if(!task)return;
  const key=JSON.stringify([task,historical?.id]);
  if(key===detailKey)return;detailKey=key;
  const content=byId('detail-content'),scroll=content.scrollTop;
  const expanded=new Set([...content.querySelectorAll('details[open]')].map(item=>item.dataset.key));
  const fragment=document.createDocumentFragment();
  fragment.append(element('h1','',task.title));
  const meta=element('div','task-meta');meta.append(element('span','badge '+(['blocked','waiting','stale','unknown','unreadable','failed'].includes(task.state)?'warning':''),task.stateLabel),element('span','badge muted',task.workflowTitle||'未归入工作流'));fragment.append(meta);
  if(task.progress) {
    const label=element('div','progress-label');label.append(element('span','',task.progress.label),element('strong','',task.progress.completed+' / '+task.progress.total+' · '+task.progress.percent+'%'));
    const track=element('div','progress-track');track.setAttribute('role','progressbar');track.setAttribute('aria-label',task.progress.label);track.setAttribute('aria-valuenow',String(task.progress.percent));track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');const fill=element('span');fill.style.width=task.progress.percent+'%';track.append(fill);
    fragment.append(label,track,element('small','',date(task.progressAt,true)+(task.progressStale?' · 上次登记值，待更新':'')));
  }else fragment.append(element('p','hint','当前显示文字进展；尚未登记可量化的完成数。'));
  if(task.reportedStage) {fragment.append(element('h2','','当前步骤'),element('p','',task.reportedStage));}
  fragment.append(element('h2','','最新进展'),element('p','',task.reportedSummary||task.latestText),element('time','',date(task.updatedAt,true)));
  if(task.readError)fragment.append(element('p','hint',task.readError+'；上次已读进展保留，恢复后自动重试。'));
  const artifacts = element('div');
  artifacts.append(element('p','hint','正在读取这条聊天的产出…'));
  fragment.append(element('h2','','任务产出'),artifacts);
  const items=task.items||[];
  fragment.append(element('h2','',items.length?'小项 · '+items.length+' 条':'小项记录'));
  if(items.length)items.forEach((item,index)=>{
    const box=element('details');box.dataset.key='item-'+(item.id||index);box.open=expanded.has(box.dataset.key)||items.length<=2;
    const label=element('summary');label.append(element('strong','',item.stateLabel||'已有记录'),document.createTextNode(item.title));box.append(label,element('p','',item.detail||'详细内容见原聊天'));
    if(item.updatedAt)box.append(element('time','',date(item.updatedAt,true)));fragment.append(box);
  });
  else fragment.append(element('p','hint','这条任务尚未提供结构化清单，可在下方逐条查看最近进展。'));
  const messages=(task.messages||[]).slice().reverse();
  if(messages.length) {
    fragment.append(element('h2','','最近公开进展 · '+messages.length+' 条'));
    messages.forEach((message,index)=>{
      const box=element('details');box.dataset.key='message-'+(message.id||index);box.open=expanded.has(box.dataset.key);
      box.append(element('summary','',date(message.at)+' · '+(message.phase==='commentary'?'进展更新':'回合答复')),element('p','',message.text));fragment.append(box);
    });
  }
  const sources=element('details');sources.dataset.key='sources';sources.open=expanded.has('sources');sources.append(element('summary','','来源与回溯'));
  sources.append(element('p','hint',task.projectRoot||'项目未登记'));
  if(task.focus)sources.append(element('p','hint','原关联说明：'+task.focus+'。当前工作以最新进展为准。'));
  const sourceList=element('ul','source-list');for(const source of task.sources||[])sourceList.append(element('li','',(source.role||'来源')+'：'+source.path));sources.append(sourceList);fragment.append(sources);
  content.replaceChildren(fragment);content.scrollTop=scroll;
  void showArtifacts(artifacts, task.id);
  byId('detail-label').textContent=historical?'历史中的任务':'任务进展';
  byId('open-thread').hidden=false;byId('detail-footnote').textContent=historical?'快照 #'+historical.id:'每 15 秒读取';
}
function renderHistory() {
  detailKey='';const content=byId('detail-content'),fragment=document.createDocumentFragment();
  fragment.append(element('h1','','任务回溯'),element('p','hint','按变化留档，共 '+historyTotal+' 份快照。回合结束后仍可查看当时的进展和来源。'));
  const actions=element('div','history-actions'),exportButton=element('button','','校验并导出历史');exportButton.type='button';
  exportButton.addEventListener('click',async()=>{exportButton.disabled=true;try{const result=await bridge.call('dockExport');notify('已校验 '+result.snapshots+' 份快照，导出到：'+result.path);}catch(issue){notify(issue.message);}finally{exportButton.disabled=false;}});actions.append(exportButton);fragment.append(actions);
  for(const item of entries) {
    const button=element('button','history-entry');button.type='button';button.append(element('strong','','#'+item.id+' · '+date(item.observedAt,true)),element('small','',item.summary));
    button.addEventListener('click',async()=>{try{await showSnapshot(await bridge.call('dockSnapshot',{id:item.id}));}catch(issue){notify(issue.message);}});fragment.append(button);
  }
  if(!entries.length)fragment.append(element('p','hint','首份任务记录正在生成。'));
  if(nextBefore>1) {const more=element('button','load-more','更早的记录');more.type='button';more.addEventListener('click',()=>showHistory(true));fragment.append(more);}
  const scroll=content.scrollTop;content.replaceChildren(fragment);content.scrollTop=scroll;
  byId('detail-label').textContent='历史回溯';byId('open-thread').hidden=true;byId('detail-footnote').textContent='来源副本与校验链';
}
async function showHistory(more=false) {
  const request=++historyRequest;mode='history';historical=null;notify('');renderList();await command('dockExpand');
  try {const result=await bridge.call('dockHistory',more?{before:nextBefore}:{});if(request!==historyRequest||mode!=='history')return;entries=more?entries.concat(result.entries):result.entries;nextBefore=result.nextBefore;historyTotal=result.total;renderHistory();}catch(issue){notify(issue.message);}
}
async function showSnapshot(snapshot) {
  mode='snapshot';const fragment=document.createDocumentFragment();
  fragment.append(element('h1','','快照 #'+snapshot.id),element('p','hint',date(snapshot.observedAt,true)));
  const back=element('button','load-more','返回历史列表');back.type='button';back.addEventListener('click',()=>{mode='history';renderHistory();});fragment.append(back);
  for(const task of snapshot.projects?.[0]?.tasks||[]) {
    const row=element('button','history-entry');row.type='button';row.append(element('strong','',task.title),element('small','',task.stateLabel+' · '+(task.latestText||'').slice(0,130)));row.addEventListener('click',()=>selectTask(task.id,snapshot));fragment.append(row);
  }
  byId('detail-content').replaceChildren(fragment);byId('detail-label').textContent='历史快照';byId('open-thread').hidden=true;
}
async function refresh() {
  if(refreshing)return;refreshing=true;byId('refresh').disabled=true;byId('refresh').textContent='读取中…';
  try {receive(await bridge.call('dockRefresh'));if(mode==='history')await showHistory();if(!view.error)notify(historical?'正在查看历史，侧边任务已刷新到最新。':'任务已刷新 · '+date(view.checkedAt));}
  catch(issue){notify(issue.message);byId('rail-error').hidden=false;byId('rail-error').textContent='刷新未完成';}
  finally {refreshing=false;byId('refresh').disabled=false;byId('refresh').textContent='↻ 刷新';}
}
byId('refresh').addEventListener('click',refresh);
byId('collapse').addEventListener('click',()=>command('dockCollapse'));
byId('panel').addEventListener('click',()=>command('dockPanel'));
byId('pin').addEventListener('click',()=>command('pin'));
byId('menu').addEventListener('click',()=>command('menu'));
byId('history').addEventListener('click',()=>showHistory());
byId('open-thread').addEventListener('click',async()=>{try{if(selected)await bridge.call('dockOpenThread',{id:selected});}catch(issue){notify(issue.message);}});
const cleanup=[bridge.onDockData(receive),bridge.onWindowState(applyState),bridge.onError(notify),bridge.onAction(action=>{if(action==='dockRefresh')refresh();})];
addEventListener('keydown',event=>{if(event.key==='Escape')command('dockCollapse');if(event.key==='F5'){event.preventDefault();refresh();}});
addEventListener('pagehide',()=>cleanup.forEach(off=>off()),{once:true});
try {applyState(await bridge.command('info'));receive(await bridge.call('dockCurrent'));}
catch(issue){notify(issue.message);byId('rail-error').hidden=false;byId('rail-error').textContent='连接未完成';}
