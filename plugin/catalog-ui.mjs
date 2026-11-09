const FLOW_NAMES = {all: '全部', eagle: 'Eagle', white: '白模', car: '汽车', general: '通用'};
const textOf = item => [item.title,item.name,item.callName,item.description,item.category,item.path,item.summary,...(item.skills || [])].filter(Boolean).join(' ').toLocaleLowerCase();
const matches = (value, query) => query.trim().toLocaleLowerCase().split(/\s+/).every(word => value.includes(word));
const formatSize = bytes => bytes == null ? '目录' : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KiB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
export function createCatalogPanel({make, button, call, render, announce, onProgress, formatTime, quick, onData, getFlows=()=>[],onAddResource,onEditResource}) {
  let data = null, tab = 'skills', flow = 'all', query = '', category = 'all', source = 'all', limit = 20, relatedSkill = null, loading = false, attempted = false;
  let pending=null,focusId=null,focusPart=null;
  const expanded = new Set(), libraryQueries = new Map(), libraryLimits = new Map();
  const read = force => {
    if(pending)return pending;if(data&&!force)return Promise.resolve(data);
    loading=true;
    pending=(async()=>{try {const started=await call(force ? 'catalogRefresh' : 'catalog', {}, value => {data = value;onData?.(value);if (force===true) announce(`目录已更新：${value.stats.skills} 个技能、${value.stats.availableResources} 个可读取的资源集合。`);});if(started!==false)attempted=true;return data;}
    finally {loading=false;pending=null;}})();return pending;
  };
  function change(action) {focusId=null;focusPart=null;action(); limit = 20; render();}
  async function copy(value, kind = 'invocation') {
    try {
      try {if (!navigator.clipboard?.writeText) throw new Error('clipboard'); await navigator.clipboard.writeText(value);}
      catch {
        const target = make('textarea'); target.value = value; target.style.position = 'fixed'; target.style.opacity = '0'; document.body.append(target); target.select();
        let copied = false; try {copied = document.execCommand('copy');} finally {target.remove();}
        if (!copied) throw new Error('复制未成功，可在用法框中选中文字复制。');
      }
      announce(kind==='path'?'已复制路径，可粘贴到资源管理器地址栏。':'已复制用法，发到对应项目的 Codex 聊天即可。');
    } catch (error) {announce(error.message);}
    render();
  }
  function promptBox(value, title = '调用示例') {
    const box = make('div', 'wm-invocation');
    const input = make('textarea'); input.readOnly = true; input.rows = 4; input.value = value; input.setAttribute('aria-label', title);
    box.append(make('h4', '', title), input, button('复制用法', () => copy(value), 'wm-secondary'));
    return box;
  }
  function searchField(label, value, placeholder, onChange, key) {
    const field = make('label', 'wm-catalog-search'); field.append(make('span', 'wm-sr-only', label));
    const input = make('input'); input.type = 'search'; input.value = value; input.placeholder = placeholder; input.setAttribute('aria-label', label); input.dataset.focusKey = key; input.autocomplete = 'off';
    let composing = false;
    input.addEventListener('compositionstart', () => {composing = true;});
    input.addEventListener('compositionend', () => {composing = false; onChange(input.value);});
    input.addEventListener('input', () => {if (!composing) onChange(input.value);});
    field.append(input); return field;
  }
  function selectField(label, values, value, onChange) {
    const field = make('label', 'wm-catalog-select'); field.append(make('span', 'wm-sr-only', label));
    const input = make('select'); input.setAttribute('aria-label', label); input.dataset.focusKey = `catalog:${label}`;
    for (const [key, name] of values) {const option = make('option', '', name); option.value = key; option.selected = key === value; input.append(option);}
    input.addEventListener('change', () => change(() => onChange(input.value))); field.append(input); return field;
  }
  function reveal(kind, item, part) {call('catalogOpen', {kind, id: item.id, ...(part ? {part: part.id} : {})},()=>announce('已发送文件定位请求。也可以复制路径，在资源管理器地址栏打开。'));}
  function entryHead(item, kind, subtitle) {
    const isOpen = expanded.has(item.id);
    const entry = make('article', `wm-catalog-entry${isOpen ? ' is-open' : ''}`); entry.dataset.catalogId = item.id;
    const toggle = button('', () => {expanded.has(item.id) ? expanded.delete(item.id) : expanded.add(item.id);if(expanded.has(item.id))quick?.visit({kind,id:item.id});render();}, 'wm-catalog-toggle');
    toggle.setAttribute('aria-expanded', String(isOpen)); toggle.setAttribute('aria-label', `${item.title} · ${isOpen ? '收起' : '展开'}${kind === 'skill' ? '技能' : '资源'}`); toggle.dataset.focusKey = item.id;
    const names = make('span'); names.append(make('strong', '', item.title), make('small', '', subtitle));
    toggle.append(names, make('span', 'wm-disclosure', isOpen ? '−' : '+'));const heading=make('div','wm-entry-heading');heading.append(toggle);if(quick)heading.append(quick.favoriteButton({kind,id:item.id},item.title));entry.append(heading);
    entry.append(make('p', `wm-catalog-description${isOpen ? ' is-open' : ''}`, item.description));
    return {entry, isOpen};
  }
  function skillEntry(item) {
    const {entry, isOpen} = entryHead(item, 'skill', item.callName);
    entry.append(make('p', 'wm-catalog-meta', `${item.sourceLabel}${item.version ? ` · v${item.version}` : ''} · ${item.category}`));
    if(item.manager)entry.append(make('p','wm-manager-status',`Skills Manager · ${item.manager.deployments.find(d=>d.agent==='codex')?.state==='matched'?'Codex 部署内容一致':item.manager.deployedTo.includes('codex')?'Codex 部署需核对':'中央库，未登记部署到 Codex'}`));
    if (!isOpen) return entry;
    if(item.manager){const section=make('div','wm-manager-skill');section.append(make('p','wm-catalog-note',`标签：${item.manager.tags.join(' · ')||'未设标签'}`),make('p','wm-catalog-note',`预设：${item.manager.presets.join(' · ')||'未加入预设'}`));for(const deployment of item.manager.deployments)section.append(make('p','wm-catalog-note',`${deployment.title}：${({matched:'SKILL.md 内容一致',different:'文件内容不同，需核对',missing:'部署文件暂不可读'})[deployment.state]}`));entry.append(section);}
    entry.append(promptBox(item.prompt), make('p', 'wm-catalog-note', item.invocationNote));
    const resources = data.resources.filter(resource => resource.skills.includes(item.name));
    if (resources.length) entry.append(button(`查看配套资源 · ${resources.length}`, () => change(() => {relatedSkill = item.name; tab = 'resources'; query = ''; category = 'all'; source = 'all'; flow = 'all';}), 'wm-text-button'));
    const paths = make('div', 'wm-catalog-paths'); paths.append(make('code', '', item.path), button('定位 Skill 文件', () => reveal('skill', item), 'wm-text-button'),button('复制 Skill 路径',()=>copy(item.path,'path'),'wm-text-button'));
    if (item.locations.length > 1) paths.append(make('p', 'wm-catalog-note', `同一技能的 ${item.locations.length} 处部署已合并：${item.locations.map(location => location.label).join('、')}`));
    for (const support of item.supports.filter(support=>!support.topic)) paths.append(button(support.label, () => reveal('skill', item, support), 'wm-catalog-file'));
    const topics=item.supports.filter(support=>support.topic);
    if(topics.length){const section=make('details','wm-catalog-scope');const topicKey=`topics:${item.id}`;section.open=expanded.has(topicKey);section.addEventListener('toggle',()=>{section.open?expanded.add(topicKey):expanded.delete(topicKey);});section.append(make('summary','',`内置制作专题 · ${topics.length}`));const list=make('div','wm-resource-files');list.dataset.scrollKey=topicKey;for(const topic of topics){const row=make('div','wm-topic');row.append(make('strong','',topic.label),button('复制专题用法',()=>copy(topic.prompt),'wm-text-button'),button('定位指南',()=>reveal('skill',item,topic),'wm-text-button'));list.append(row);}section.append(list);paths.append(section);}
    entry.append(paths); return entry;
  }
  function renderLibrary(item) {
    const library = item.library, state = libraryQueries.get(item.id) || '', shown = libraryLimits.get(item.id) || 12;
    const section = make('section', 'wm-library'); section.setAttribute('aria-label', '动作库检索');
    section.append(make('h4', '', `逐项检索 · ${library.motions} 动作 / ${library.poses} 姿势`));
    section.append(searchField('搜索动作或姿势', state, '输入名称、编号、分类，例如：后空翻', value => {focusPart=null;libraryQueries.set(item.id, value); libraryLimits.set(item.id, 12); render();}, `library:${item.id}`));
    const values = library.entries.filter(entry => (!focusPart||item.id!==focusId||entry.id===focusPart)&&matches(`${entry.title} ${entry.id} ${entry.category} ${entry.kind === 'motion' ? '动作' : '姿势'}`.toLocaleLowerCase(), state));
    section.append(make('p', 'wm-catalog-note', `${values.length} 项匹配 · 按目录原编号调用；提示状态保留原记录。`));
    const list = make('div', 'wm-library-list'); list.dataset.scrollKey = `library:${item.id}:${state}`;
    for (const value of values.slice(0, shown)) {
      const row = make('div', 'wm-library-entry');row.dataset.partId=value.id;const heading=make('div','wm-entry-heading');heading.append(make('strong','',value.title));if(quick)heading.append(quick.favoriteButton({kind:value.kind,id:value.id,parentId:item.id},value.title));row.append(heading, make('code', '', value.id));
      row.append(make('small', '', `${value.kind === 'pose' ? '静态姿势' : value.entryType === 'composition' ? '组合动作' : '动作'} · ${value.category}${value.duration ? ` · ${Number(value.duration.toFixed(2))} 秒` : ''}`));
      const status = value.continuity === 'review_required' ? `连续性待复核${value.windows != null ? ` · ${value.windows} 个提示窗口` : ''}` : value.continuity === 'no_flags_at_sampled_times' ? '目录采样无提示 · 调用时按当前检测器复核' : value.kind === 'pose' ? '静态姿势 · 接触与角色适配按镜头检查' : '连续性状态未登记';
      row.append(make('p', value.continuity === 'review_required' ? 'wm-issue' : 'wm-catalog-note', status));
      if (value.note) row.append(make('p', 'wm-catalog-note', value.note));
      const invocation = `使用 $blender-expert-suite，在项目 ${library.projectRoot} 中先读取 ${library.guide}。\n从当前登记的正式动作库选择${value.kind === 'pose' ? '姿势' : '动作'}「${value.title}」（编号 ${value.id}），沿用完整人物约束，在独立新工程生成候选，按当前检测器复核连续性、人物接触和参考匹配。保留原库与已有工程。`;
      row.append(button('复制这项的用法', async () => {await copy(invocation);quick?.visit({kind:value.kind,id:value.id,parentId:item.id});}, 'wm-text-button')); list.append(row);
    }
    if (!values.length) list.append(make('p', 'wm-empty', '没有匹配项，可换一个动作名或编号。'));
    section.append(list);
    if (values.length > shown) section.append(button(`再显示 24 项 · 当前 ${shown}/${values.length}`, () => {libraryLimits.set(item.id, shown + 24); render();}, 'wm-text-button'));
    return section;
  }
  function resourceEntry(item) {
    const {entry, isOpen} = entryHead(item, 'resource', `${item.category} · ${item.available ? item.summary || '路径可读取' : '当前不可读取'}`);
    if (!isOpen) return entry;
    if(item.custom&&onEditResource)entry.append(button('编辑这项资源',()=>onEditResource(item.id),'wm-text-button'));
    if (!item.available) entry.append(make('p', 'wm-error', item.issue));
    if (item.note) entry.append(make('p', 'wm-catalog-note', item.note));
    const linked = make('div', 'wm-catalog-links');
    for (const skill of item.skills) {
      const found = data.skills.find(record => record.name === skill && record.sourceKind === 'codex') || data.skills.find(record => record.name === skill);
      if (found) linked.append(button(found.title, () => change(() => {tab = 'skills'; flow = 'all'; relatedSkill = null; query = skill; category = 'all'; source = 'all'; expanded.add(found.id);}), 'wm-catalog-file'));
    }
    entry.append(linked, promptBox(item.prompt, '资源调用示例'), make('code', 'wm-catalog-location', item.path));
    if (item.available) entry.append(button(item.kind === 'file' ? '定位资源文件' : '打开资源目录', () => reveal('resource', item), 'wm-text-button'));
    entry.append(button('复制资源路径',()=>copy(item.path,'path'),'wm-text-button'));
    if (item.library) entry.append(renderLibrary(item));
    if (item.parts.length) {
      const files = make('div', 'wm-resource-files'); files.dataset.scrollKey = `resource:${item.id}`; files.setAttribute('aria-label', `${item.title}中的文件`);
      for (const part of item.parts) {
        const file = button('', () => reveal('resource', item, part), `wm-resource-file${focusPart===part.id?' is-selected':''}`); file.title = part.path;file.dataset.partId=part.id;file.dataset.focusKey=`file:${item.id}:${part.id}`;
        file.append(make('span', '', part.label), make('small', '', formatSize(part.bytes))); files.append(file);
      }
      entry.append(make('h4', '', item.library ? '工程与登记来源' : '可定位的文件与目录'), files);
      const chosen=item.parts.find(part=>part.id===focusPart);
      if(chosen)entry.append(make('p','wm-catalog-note',`已定位文件：${chosen.label}`),make('code','wm-catalog-location',chosen.path),button('复制所选文件路径',()=>copy(chosen.path,'path'),'wm-text-button'));
    }
    return entry;
  }
  function append(body) {
    const names={...FLOW_NAMES,...Object.fromEntries(getFlows().map(flow=>[flow.id,flow.title]))};
    const head = make('div', 'wm-catalog-heading'); head.append(make('h3', '', '我的技能与资源'), make('span', 'wm-local', '本机目录')); body.append(head);
    body.append(make('p', 'wm-catalog-intro', '选择工作流，查用途与现成资源。复制用法后发到对应项目的 Codex 聊天，替换方括号中的资料。'));
    if (!data) {body.append(make('p', 'wm-loading', '正在核对技能与资源目录…'), button('重新读取目录', () => read(false), 'wm-secondary')); return;}
    const overview = make('div', 'wm-overview wm-catalog-overview');
    const totalEntries = data.resources.reduce((n, item) => n + (item.library?.entries.length || 0), 0);
    for (const [value, label] of [[data.stats.skills, '独立技能'], [data.stats.availableResources, '资源集合'], [totalEntries, '动作与姿势']]) {const cell = make('div'); cell.append(make('strong', '', String(value)), make('span', '', label)); overview.append(cell);}
    body.append(overview);
    const manager=make('details','wm-manager-panel');manager.open=expanded.has('manager');manager.addEventListener('toggle',()=>{manager.open?expanded.add('manager'):expanded.delete('manager');});const status=data.manager;manager.append(make('summary','',status?.connected?`Skills Manager · 已连接 · ${status.skillCount} 项中央技能`:'Skills Manager · 连接待核对'));
    if(status?.connected)manager.append(make('p','wm-catalog-note',`v${status.version} · ${status.presets.length} 个预设 · ${status.agents.length} 个已发现客户端。核对时间 ${formatTime(status.capturedAt,true)}。`),make('p','wm-catalog-note','中央库、预设归属与部署分别读取；展开技能可看标签和各客户端文件核对结果。页面打开时每 60 秒同步目录。'));
    else manager.append(make('p','wm-issue',status?.issue||'请在关联页设置 Skills Manager 目录。'));
    const controls=make('div','wm-task-actions');controls.append(button('打开 Skills Manager',()=>call('managerOpen',{},()=>announce('已发送 Skills Manager 打开请求。')),'wm-secondary'),button('同步管理器与目录',()=>read(true),'wm-text-button'));manager.append(controls);body.append(manager);
    const flowNav = make('div', 'wm-catalog-flows'); flowNav.setAttribute('aria-label', '按工作流筛选');
    for (const [id, name] of Object.entries(names)) {const b = button(name, () => change(() => {flow = id; relatedSkill = null; category = 'all';focusId=null;focusPart=null;}), flow === id ? 'is-active' : ''); b.setAttribute('aria-pressed', String(flow === id)); flowNav.append(b);}
    body.append(flowNav);
    const tabs = make('div', 'wm-catalog-tabs');
    for (const [key, label] of [['skills','全部技能'],['resources','已有资源']]) {const b = button(label, () => change(() => {tab = key; category = 'all'; source = 'all'; relatedSkill = null;focusId=null;focusPart=null;}), key === tab ? 'is-active' : ''); b.setAttribute('aria-pressed', String(key === tab)); tabs.append(b);}
    if (flow !== 'all' && flow !== 'general') tabs.append(button('看当前任务', () => onProgress(flow), 'wm-text-button'));
    body.append(tabs, searchField('搜索技能或资源', query, tab === 'skills' ? '搜索用途、技能名，例如：灯光' : '搜索资源名称，例如：动作库', value => change(() => {query = value;focusId=null;focusPart=null;}), 'catalog:search'));
    if(tab==='resources'&&onAddResource)body.append(button('＋ 添加资源',onAddResource,'wm-secondary'));
    const records = tab === 'skills' ? data.skills : data.resources;
    const categories = [...new Set(records.map(item => item.category))].sort((a,b) => a.localeCompare(b,'zh-CN'));
    const filters = make('div', 'wm-catalog-filters'); filters.append(selectField('资源或技能分类', [['all','全部分类'], ...categories.map(value => [value,value])], category, value => {category = value;}));
    if (tab === 'skills') filters.append(selectField('技能来源', [['all','全部来源'],['codex','Codex 本机'],['plugin','插件技能'],['system','系统技能'],['central','仅中央库']], source, value => {source = value;}));
    body.append(filters);
    if (relatedSkill) {const line = make('div','wm-catalog-related'); line.append(make('span','',`配套资源 · ${relatedSkill}`),button('清除',()=>change(()=>{relatedSkill=null;}),'wm-text-button'));body.append(line);}
    const filtered = records.filter(item => (!focusId||item.id===focusId) && (flow === 'all' || item.workflows.includes(flow)) && (category === 'all' || item.category === category) && (source === 'all' || tab !== 'skills' || item.sourceKind === source) && (!relatedSkill || item.skills?.includes(relatedSkill)) && matches(textOf(item), query));
    body.append(make('p', 'wm-catalog-result', `${filtered.length} 项匹配${flow !== 'all' ? ` · ${names[flow]||flow}流程` : ''}`));
    if(focusId)body.append(button('查看全部目录',()=>change(()=>{focusId=null;focusPart=null;}),'wm-text-button'));
    const list = make('div', 'wm-catalog-list'); list.dataset.scrollKey = `catalog:${tab}:${flow}:${query}:${category}:${source}:${relatedSkill || ''}`;
    if (!filtered.length) list.append(make('p', 'wm-empty', '没有匹配项，试试清空搜索或切换到“全部”。'));
    for (const item of filtered.slice(0, limit)) list.append(tab === 'skills' ? skillEntry(item) : resourceEntry(item));
    body.append(list);
    if (filtered.length > limit) body.append(button(`再显示 20 项 · 当前 ${limit}/${filtered.length}`, () => {limit += 20; render();}, 'wm-secondary wm-catalog-more'));
    const tools = make('div','wm-catalog-tools'); tools.append(button('重新扫描',()=>read(true),'wm-secondary'),button('导出完整清单',()=>call('catalogExport',{},result=>announce(`已导出 ${result.skills} 项技能及资源用法：${result.path}`)),'wm-secondary'));body.append(tools);
    body.append(make('p','wm-catalog-note',`${data.stats.codexSkills || 0} 个 Codex 本机技能 · ${data.stats.pluginSkills || 0} 个插件技能 · ${data.stats.systemSkills || 0} 个系统技能。部署副本已合并；软件连接在调用时检查。`));
    const scope=make('details','wm-catalog-scope');scope.append(make('summary','','查看扫描范围与来源'),make('p','wm-catalog-note',data.scope || ''),make('p','wm-catalog-note',`扫描于 ${formatTime(data.scannedAt,true)}。目录按需扫描，记录保存在弹窗自己的数据目录；实时任务继续每 15 秒更新。`));
    if(data.sourceFile)scope.append(make('code','',data.sourceFile));for(const issue of data.issues||[])scope.append(make('p','wm-issue',issue));
    body.append(scope);
  }
  return {append,load:read,peek:()=>data,accept(value){data=value;attempted=true;onData?.(value);},showResources(){tab='resources';flow='all';query='';category='all';source='all';focusId=null;focusPart=null;},scannedAt:()=>data?.scannedAt,invalidate(){data=null;attempted=false;onData?.(null);},focusTarget(target){
    const skill=['skill','topic'].includes(target.kind);const id=target.parentId||target.id;const record=(skill?data?.skills:data?.resources)?.find(item=>item.id===id);if(!record)return false;
    tab=skill?'skills':'resources';flow='all';query='';category='all';source='all';relatedSkill=null;focusId=id;focusPart=['motion','pose','file'].includes(target.kind)?target.id:null;expanded.add(id);limit=20;
    if(target.kind==='topic')expanded.add(`topics:${id}`);if(['motion','pose'].includes(target.kind)){libraryQueries.set(id,target.id);libraryLimits.set(id,12);}return true;
  },open(nextFlow){if(nextFlow){flow=nextFlow;query='';category='all';source='all';relatedSkill=null;focusId=null;focusPart=null;limit=20;}if(!data&&!loading&&!attempted)read(false);}};
}
