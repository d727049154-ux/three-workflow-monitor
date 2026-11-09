export function createActivityPanel({make,button,call,render,formatTime,getWorkspace,setWorkspace,getSnapshot,onSnapshot,onTask,onBack}) {
  let data=null,loading=false,flow='all',unreadOnly=false;
  async function load(more=false){if(loading)return;loading=true;try{await call('activity',more?{before:data?.nextBefore}:{},value=>{data=more&&data?{...data,events:[...data.events,...value.events],nextBefore:value.nextBefore,scannedSnapshots:data.scannedSnapshots+value.scannedSnapshots}:value;});}finally{loading=false;}}
  function append(body){
    const heading=make('div','wm-linked-heading');heading.append(make('h3','','最近变化'),button('返回实时',onBack,'wm-text-button'));body.append(heading,make('p','wm-catalog-intro','按留档时间查看工作流与任务的变化，随时回到当时的快照。'));
    if(!data){body.append(make('p','wm-loading','正在读取变化…'));return;}
    const seen=getWorkspace().seen;
    const tools=make('div','wm-shortcuts');tools.append(button('刷新变化',()=>load(),'wm-secondary'));
    if(data.head)tools.append(button(seen?'标记至此已读':'从这里开始标记已读',()=>call('activitySeen',data.head,setWorkspace),'wm-secondary'));
    body.append(tools,make('p','wm-catalog-note',seen?`已读位置 #${seen.id} · 本页截至 #${data.head?.id}，标记只推进到本页位置。`:`尚未设置已读位置。标记后，后续变化会显示“未读”。本页截至 #${data.head?.id}。`));
    if(getSnapshot()?.id>data.head?.id)body.append(make('p','wm-change-new','有新的留档，点“刷新变化”查看；当前阅读位置保留。'));
    const filters=make('div','wm-catalog-flows');const values=new Map([['all','全部流程'],...data.events.map(event=>[event.workflow,event.workflowTitle])]);for(const [id,title] of values){if(!id)continue;const b=button(title,()=>{flow=id;render();},flow===id?'is-active':'');b.setAttribute('aria-pressed',String(flow===id));filters.append(b);}body.append(filters);
    if(seen){const b=button(unreadOnly?'显示全部变化':'只看未读',()=>{unreadOnly=!unreadOnly;render();},'wm-text-button');b.setAttribute('aria-pressed',String(unreadOnly));body.append(b);}
    const visible=data.events.filter(event=>(flow==='all'||event.workflow===flow)&&(!unreadOnly||!seen||event.snapshotId>seen.id));
    const list=make('div','wm-change-list');list.dataset.scrollKey=`activity:${flow}:${unreadOnly}`;
    const labels={linked:'新增关联',updated:'任务更新',unlinked:'解除关联','workflow-linked':'新增工作流','workflow-updated':'流程记录更新'};
    for(const event of visible){
      const row=make('article',`wm-change${seen&&event.snapshotId>seen.id?' is-unread':''}`);row.dataset.changeKey=event.key;
      row.append(make('small','wm-change-time',`${formatTime(event.observedAt,true)} · #${event.snapshotId}${seen&&event.snapshotId>seen.id?' · 未读':''}`),make('strong','',event.title),make('span','wm-catalog-meta',`${event.workflowTitle} · ${labels[event.kind]||'状态更新'}`),make('p','',event.summary));
      if(event.sourceAt)row.append(make('small','wm-catalog-note',`来源时间 ${formatTime(event.sourceAt,true)}`));
      const actions=make('div','wm-task-actions');actions.append(button('看当时快照',()=>onSnapshot(event),'wm-text-button'));if(event.taskId&&getSnapshot()?.projects.some(p=>p.tasks?.some(t=>t.id===event.taskId)))actions.append(button('看当前任务',()=>onTask(event.taskId),'wm-text-button'));row.append(actions);list.append(row);
    }
    body.append(make('p','wm-catalog-result',`已读取最近 ${data.scannedSnapshots} 份快照 · 当前筛选 ${visible.length} 条变化`),list);
    if(!visible.length)body.append(make('p','wm-empty',unreadOnly?'这部分记录没有未读变化。':'这部分留档没有任务变化，可继续读取更早记录。'));
    if(data.nextBefore)body.append(button('读取更早变化',()=>load(true),'wm-secondary'));
  }
  return {append,open(){flow='all';unreadOnly=false;load();}};
}
