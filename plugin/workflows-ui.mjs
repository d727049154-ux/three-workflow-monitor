import {copyText} from './clipboard.mjs';
export function createWorkflowEditor({make,button,call,render,announce,getWorkspace,getCatalog,loadCatalog,onSaved,onCancel}) {
  let draft=null,revision=0;
  function open(flow){revision=getWorkspace().revision;draft=flow?{...structuredClone(flow),stageText:flow.stages.map(s=>s.label).join('，'),threadText:flow.threadIds.join('，')}:{title:'',root:'',stageText:'分析，制作，验收',threadText:'',autoDiscover:true,skillIds:[],resourceIds:[]};loadCatalog();}
  function field(form,label,key,placeholder=''){
    const wrap=make('label','wm-field');wrap.append(make('span','',label));const input=make('input');input.name=key;input.value=draft[key]||'';input.placeholder=placeholder;input.autocomplete='off';input.dataset.focusKey=`workflow:${key}`;input.addEventListener('input',()=>{draft[key]=input.value;});wrap.append(input);form.append(wrap);return input;
  }
  function choices(form,records,key,title){
    const section=make('section','wm-flow-choices');section.append(make('h4','',title));
    const search=make('input');search.type='search';search.placeholder=`筛选${title}`;search.setAttribute('aria-label',`筛选${title}`);section.append(search);
    const list=make('div','wm-flow-choice-list');list.dataset.scrollKey=`flow:${key}`;
    for(const item of records){const row=make('label','wm-flow-choice');row.dataset.search=`${item.title} ${item.name||''} ${(item.manager?.tags||[]).join(' ')}`.toLocaleLowerCase();const input=make('input');input.type='checkbox';input.value=item.id;input.checked=draft[key].includes(item.id);input.setAttribute('aria-label',`${title}：${item.title}`);input.addEventListener('change',()=>{draft[key]=input.checked?[...draft[key],item.id]:draft[key].filter(id=>id!==item.id);});const text=make('span');text.append(make('strong','',item.title),make('small','',item.manager?`Skills Manager · ${item.manager.deployedTo.includes('codex')?'已登记部署到 Codex':'中央库'}`:item.sourceLabel||item.category));row.append(input,text);list.append(row);}
    search.addEventListener('input',()=>{for(const row of list.children)row.hidden=!row.dataset.search.includes(search.value.trim().toLocaleLowerCase());});section.append(list);form.append(section);
  }
  function append(body){
    if(!draft)open();const heading=make('div','wm-linked-heading');heading.append(make('h3','',draft.id?'编辑工作流':'新增工作流'),button('返回',onCancel,'wm-text-button'));body.append(heading,make('p','wm-catalog-intro','登记一个观察入口。工程中的进度记录每 15 秒更新；也可以自动关联这个工程的本机聊天。'));
    const form=make('form','wm-form wm-workflow-form');field(form,'流程名称','title','例如：产品灯光与材质').required=true;field(form,'现有工程目录（可稍后填写）','root','D:\\你的项目');field(form,'流程环节（用逗号分开）','stageText').required=true;
    const auto=make('label','wm-flow-auto');const check=make('input');check.type='checkbox';check.checked=draft.autoDiscover;check.addEventListener('change',()=>{draft.autoDiscover=check.checked;});auto.append(check,make('span','','自动纳入此工程的本机聊天，每 60 秒发现新增'));form.append(auto);
    field(form,'指定聊天 ID（可选，用逗号分开）','threadText','粘贴原聊天链接末尾的完整 UUID');
    form.append(make('p','wm-catalog-note','自动关联按工程目录精确匹配最近 200 条有标题的本机聊天，每个流程最多 40 条。其他目录的任务可填完整聊天 ID。不会新建或发消息到聊天。'));
    const catalog=getCatalog();if(catalog){choices(form,catalog.skills,'skillIds','关联技能');const paused=(getWorkspace().resources||[]).filter(item=>item.paused).map(item=>({...item,category:`${item.category} · 已停用扫描，关联保留`}));choices(form,[...catalog.resources,...paused],'resourceIds','关联资源');}else form.append(make('p','wm-loading','正在载入可关联的技能与资源…'));
    const save=make('button','wm-button wm-primary',draft.id?'保存工作流':'添加并开始观察');save.type='submit';save.disabled=!catalog;form.append(save);
    form.addEventListener('submit',event=>{event.preventDefault();const values={...draft,stages:draft.stageText.split(/[,，、\n]/).map(x=>x.trim()).filter(Boolean),threadIds:draft.threadText.split(/[,，、\s]+/).filter(Boolean)};call('workflowSave',{expectedRevision:revision,workflow:values},result=>{announce('工作流已保存，自动读取与历史回溯已启用。');onSaved(result);});});body.append(form);
  }
  function appendManagement(body,onEdit,onView){
    const section=make('section','wm-flow-management');section.append(make('h4','','自定义工作流'),button('＋ 新建工作流',()=>onEdit(),'wm-secondary'));
    for(const flow of getWorkspace().workflows||[]){const row=make('div','wm-flow-managed');row.append(make('strong','',flow.title),make('small','',flow.paused?'已暂停观察 · 历史保留':'自动观察中'));const actions=make('div','wm-task-actions');actions.append(button('编辑',()=>onEdit(flow),'wm-text-button'),button('复制进度接入用法',()=>call('workflowPrompt',{id:flow.id},async result=>{await copyText(result.prompt);announce('已复制进度接入用法，发到对应项目聊天即可。');}),'wm-text-button'),button(flow.paused?'恢复观察':'暂停观察',()=>call('workflowPause',{id:flow.id,paused:!flow.paused},onView),'wm-text-button'));row.append(actions);section.append(row);}body.append(section);
  }
  return {open,append,appendManagement};
}
