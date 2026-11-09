import {buildEntries,targetKey} from './targets.mjs';
import {SearchIndex} from './search.mjs';
export function createQuickPanel({make,button,call,render,announce,onNavigate,onClose,loadCatalog}) {
  let snapshot=null,catalog=null,workspace={favorites:[],recent:[],seen:null,workflows:[]},index=null,indexKey='',query='',kind='all',active=0,limit=30;
  const entries=()=>{
    const key=`${snapshot?.id}:${catalog?.fingerprint}:${catalog?.manager?.fingerprint}:${workspace.revision}`;
    if(!index||key!==indexKey){index=new SearchIndex(buildEntries(snapshot,catalog));indexKey=key;}return index.entries;
  };
  const find=target=>entries().find(entry=>entry.key===targetKey(target));
  const isFavorite=target=>workspace.favorites.some(item=>item.key===targetKey(target));
  function setWorkspace(value){if(value?.schema==='workflow-workspace/1')workspace=value;}
  async function visit(target){await call('quickVisit',{target},setWorkspace);}
  async function navigate(target){
    if(!['workflow','task','item'].includes(target.kind)&&!catalog)await loadCatalog();
    const entry=find(target);if(!entry){announce('这个入口当前不在目录中；收藏记录保留，可刷新目录或取消收藏。');render();return;}
    if(await onNavigate(entry.target)!==false)await visit(entry.target);
  }
  function favoriteButton(target,title){
    const selected=isFavorite(target);const control=button(selected?'★':'☆',()=>call('quickFavorite',{target,enabled:!selected},value=>{setWorkspace(value);announce(selected?'已取消收藏。':'已收藏，可从顶部搜索或实时页直接进入。');}),'wm-favorite');
    control.setAttribute('aria-label',`${selected?'取消收藏':'收藏'} ${title}`);control.setAttribute('aria-pressed',String(selected));control.dataset.focusKey=`favorite:${targetKey(target)}`;return control;
  }
  function storedRows(body,items,emptyText){
    if(!items.length){body.append(make('p','wm-catalog-note',emptyText));return;}
    for(const item of items){
      const entry=find(item.target);const row=make('div','wm-saved-row');const go=button('',()=>navigate(item.target),'wm-saved-link');go.append(make('strong','',entry?.title||item.title),make('small','',entry?`${entry.kindLabel} · ${entry.subtitle}`:catalog?'当前目录中未找到 · 记录保留':'载入目录后定位'));row.append(go);
      if(workspace.favorites.some(f=>f.key===item.key))row.append(favoriteButton(item.target,entry?.title||item.title));body.append(row);
    }
  }
  function appendHome(body,onSearch,onChanges,onNew){
    const bar=make('div','wm-shortcuts');bar.append(button('最近变化',onChanges,'wm-secondary'),button('＋ 新建工作流',onNew,'wm-secondary'));
    body.append(bar);
    if(workspace.favorites.length){const section=make('section','wm-home-favorites');const heading=make('div','wm-linked-heading');heading.append(make('strong','',`收藏 · ${workspace.favorites.length}`),button('全部入口',onSearch,'wm-text-button'));section.append(heading);storedRows(section,workspace.favorites.slice(0,3),'');body.append(section);}
  }
  function append(body){
    entries();const heading=make('div','wm-linked-heading');heading.append(make('h3','','快速查找'),button('返回',onClose,'wm-text-button'));body.append(heading);
    const field=make('label','wm-catalog-search');const input=make('input');input.type='search';input.placeholder='任务、技能、资源或动作，例如：后空翻';input.value=query;input.maxLength=160;input.autocomplete='off';input.dataset.focusKey='quick:query';input.setAttribute('aria-label','统一搜索');input.setAttribute('role','combobox');input.setAttribute('aria-expanded',String(Boolean(query.trim())));input.setAttribute('aria-controls','wm-quick-results');input.setAttribute('aria-autocomplete','list');
    const results=query.trim()?index.search(query,{kind,limit:limit+1}):[];
    active=Math.min(active,Math.max(0,Math.min(results.length,limit)-1));if(results.length)input.setAttribute('aria-activedescendant',`wm-result-${active}`);
    let composing=false;input.addEventListener('compositionstart',()=>{composing=true;});const update=()=>{query=input.value;active=0;limit=30;render();};input.addEventListener('compositionend',()=>{composing=false;update();});input.addEventListener('input',()=>{if(!composing)update();});
    input.addEventListener('keydown',event=>{if(composing||event.isComposing)return;if(['ArrowDown','ArrowUp'].includes(event.key)&&results.length){event.preventDefault();active=(active+(event.key==='ArrowDown'?1:-1)+Math.min(results.length,limit))%Math.min(results.length,limit);render();}else if(event.key==='Enter'&&results[active]){event.preventDefault();navigate(results[active].target);}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}});
    field.append(input);body.append(field,make('p','wm-catalog-note',catalog?`本地检索 ${index.entries.length} 个入口 · 支持错字近似匹配、白膜/白模与 edgle 别名`:'任务可先查询；正在载入技能、资源与动作目录…'));
    const filters=make('div','wm-catalog-flows');filters.setAttribute('aria-label','搜索类型');for(const [value,label] of [['all','全部'],['task','流程与任务'],['skill','技能'],['resource','资源'],['motion','动作/姿势']]){const b=button(label,()=>{kind=value;active=0;render();},kind===value?'is-active':'');b.setAttribute('aria-pressed',String(kind===value));filters.append(b);}body.append(filters);
    if(!query.trim()){
      body.append(make('h4','','我的收藏'));storedRows(body,workspace.favorites,'展开任务、技能或资源后点 ☆ 收藏，也可以收藏单条动作。');body.append(make('h4','','最近查看'));storedRows(body,workspace.recent.slice(0,8),'打开或使用过的入口会出现在这里，重新打开弹窗仍会保留。');
    }else{
      const list=make('div','wm-quick-results');list.id='wm-quick-results';list.setAttribute('role','listbox');list.setAttribute('aria-label','统一搜索结果');list.dataset.scrollKey=`quick:${query}:${kind}`;
      for(const [i,entry] of results.slice(0,limit).entries()){
        const row=button('',()=>navigate(entry.target),`wm-quick-result${active===i?' is-selected':''}`);row.id=`wm-result-${i}`;row.setAttribute('role','option');row.setAttribute('aria-selected',String(active===i));row.dataset.targetKey=entry.key;row.append(make('span','wm-result-type',entry.kindLabel),make('strong','',entry.title),make('small','',entry.subtitle));list.append(row);
      }
      body.append(make('p','wm-catalog-result',`${results.length>limit?`${limit}+`:results.length} 项匹配 · ↑↓ 选择，Enter 查看，Esc 返回`),list);
      if(!results.length)body.append(make('p','wm-empty','没有找到，试试更短的词或切换到“全部”。'));
      if(results.length>limit)body.append(button('再显示 30 项',()=>{limit+=30;render();},'wm-secondary'));
    }
  }
  return {append,appendHome,favoriteButton,visit,navigate,setWorkspace,state:()=>workspace,setSnapshot(value){snapshot=value;},setCatalog(value){catalog=value;indexKey='';},open(){query='';kind='all';active=0;loadCatalog();},afterRender(root){const input=root.querySelector('[data-focus-key="quick:query"]');if(document.activeElement===input)root.querySelector('.wm-quick-result.is-selected')?.scrollIntoView({block:'nearest'});}};
}
