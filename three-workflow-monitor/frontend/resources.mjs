import { call, native, element, notify } from './bridge.mjs';

export function mountResources(container, subscribe, refresh) {
  if (!container) return;
  let view;
  let listKey;
  let query = '';
  let filter = 'all';
  const section = element('section', 'panel resources');
  const connections = element('div', 'resource-connections');
  const issues = element('div', 'error');
  const list = element('div', 'resource-list');
  const editor = element('div', 'resource-editor');
  const connectionEditor = element('div', 'resource-connection-editor');
  function button(text, action) {
    const node = element('button', '', text);
    node.type = 'button';
    node.addEventListener('click', () => Promise.resolve().then(action).catch(error => notify(String(error))));
    return node;
  }
  function field(form, title, value, update, multiline = false) {
    const label = element('label', 'workflow-field', title);
    const input = element(multiline ? 'textarea' : 'input');
    input.value = value;
    input.addEventListener('input', () => update(input.value));
    label.append(input); form.append(label); return input;
  }
  const search = element('input');
  search.type = 'search'; search.placeholder = '搜索名称、分类、内容或路径';
  search.setAttribute('aria-label', '搜索资源');
  search.addEventListener('input', () => { query = search.value; renderList(); });
  const filters = element('select'); filters.setAttribute('aria-label', '筛选资源');
  for (const [value, title] of [['all', '全部资源'], ['favorites', '收藏'], ['recent', '最近访问']]) {
    const option = element('option', '', title); option.value = value; filters.append(option);
  }
  filters.addEventListener('change', () => { filter = filters.value; renderList(); });
  section.append(element('h2', '', '技能与资源'), element('p', 'hint', '按需登记本机资源，或选择 Markdown 目录、JSON 清单。未连接时也可使用手工资源。文件只在资源管理器中显示。'),
    button('登记资源', () => editResource()), button('接入目录或清单', () => editConnection()), issues, connections, connectionEditor, search, filters, list, editor);
  container.append(section);

  function savingForm(host, title, revision, method, args) {
    const form = element('form'); form.append(element('h3', '', title));
    const status = element('p', 'error'); status.setAttribute('role', 'status');
    const save = element('button', 'primary', '保存'); save.type = 'submit';
    const retry = button('使用最新版本重试草稿', async () => {
      await refresh({ fresh: true });
      if (!view?.workspace) throw new Error(view?.workspaceError || '工作区尚未读取');
      revision = view.workspace.revision;
      status.textContent = '已选择最新版本，请核对列表与草稿后再保存。'; retry.hidden = true;
    }); retry.hidden = true;
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true;
      try {
        await call(method, { ...args(), expectedRevision: revision });
        host.replaceChildren(); await refresh({ fresh: true }); notify('资源配置已保存');
      } catch (error) { status.textContent = `${error}。编辑内容仍保留。`; retry.hidden = !String(error).includes('其他窗口'); }
      finally { save.disabled = false; }
    });
    host.replaceChildren(form);
    return { form, finish() { form.append(status, save, button('取消编辑', () => host.replaceChildren()), retry); } };
  }
  function workspace() {
    if (!view?.workspace) throw new Error(view?.workspaceError || '工作区尚未读取');
    return view.workspace;
  }
  function editConnection(connection) {
    const draft = connection ? structuredClone(connection) : { kind: 'directory', path: '' };
    const { form, finish } = savingForm(connectionEditor, connection ? '切换资源连接' : '接入可选资源', workspace().revision, 'resourceConnect', () => ({ connection: draft }));
    const label = element('label', 'workflow-field', '连接类型');
    const kind = element('select');
    for (const [value, title] of [['directory', 'Markdown 目录'], ['catalog', 'JSON 资源清单']]) {
      const option = element('option', '', title); option.value = value; kind.append(option);
    }
    kind.value = draft.kind; kind.addEventListener('change', () => { draft.kind = kind.value; }); label.append(kind); form.append(label);
    const path = field(form, '绝对路径', draft.path, value => { draft.path = value; }); path.required = true;
    form.append(button('选择路径', async () => { const selected = await native('pick_source', { kind: draft.kind }); if (selected) { draft.path = selected; path.value = selected; } }),
      element('p', 'hint', '目录读取最多 5 层、300 个 Markdown 文件，总内容最多 512 KiB。清单为 JSON 数组，每项填写唯一 id、title、kind（file 或 prompt）、path 或 content，可选 category；文件须位于清单目录内。'));
    finish(); path.focus();
  }
  function editResource(resource) {
    const draft = resource ? structuredClone(resource) : { title: '', kind: 'prompt', path: '', content: '', category: '', workflowIds: [], paused: false };
    const imported = !!draft.connectionId;
    const { form, finish } = savingForm(editor, imported ? '编辑资源分类与关联' : (resource ? '编辑资源' : '登记资源'), workspace().revision, 'resourceSave', () => ({ resource: draft }));
    const title = field(form, '资源名称', draft.title, value => { draft.title = value; }); title.maxLength = 100; title.required = true; title.readOnly = imported;
    if (!imported) {
      const label = element('label', 'workflow-field', '类型'); const kind = element('select');
      for (const [value, name] of [['prompt', '提示词'], ['file', '本机文件']]) { const option = element('option', '', name); option.value = value; kind.append(option); }
      kind.value = draft.kind; kind.addEventListener('change', () => { draft.kind = kind.value; }); label.append(kind); form.append(label);
      const path = field(form, '文件绝对路径（文件资源必填）', draft.path, value => { draft.path = value; });
      form.append(button('选择文件', async () => { const selected = await native('pick_source', { kind: 'file' }); if (selected) { draft.path = selected; path.value = selected; draft.kind = 'file'; kind.value = 'file'; } }));
      const content = field(form, '说明或提示词（提示词必填）', draft.content, value => { draft.content = value; }, true); content.maxLength = 16000;
    } else form.append(element('p', 'hint', '名称和内容读取所选来源；修改源文件后刷新即可更新。分类、暂停和关联保存在当前工作区。'));
    const category = field(form, '自定义分类（可选）', draft.category, value => { draft.category = value; }); category.maxLength = 60;
    form.append(element('p', 'hint', '关联工作流（可选）'));
    for (const flow of view.workspace.workflows) {
      const label = element('label', 'workflow-source'); const input = element('input'); input.type = 'checkbox'; input.checked = draft.workflowIds.includes(flow.id);
      input.addEventListener('change', () => { draft.workflowIds = input.checked ? [...draft.workflowIds, flow.id] : draft.workflowIds.filter(id => id !== flow.id); });
      label.append(input, document.createTextNode(flow.title)); form.append(label);
    }
    finish(); title.focus();
  }
  async function mutate(method, args) { await call(method, { ...args, expectedRevision: workspace().revision }); await refresh({ fresh: true }); }
  function renderList() {
    if (!view?.workspace) { list.replaceChildren(); return; }
    const ws = view.workspace;
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    let items = (view.resourceCatalog?.resources || []).filter(item => terms.every(term => [item.title, item.category, item.content, item.path].join('\n').toLocaleLowerCase().includes(term)));
    if (filter === 'favorites') items = items.filter(item => ws.favorites.includes(item.id));
    if (filter === 'recent') items = ws.recent.map(id => items.find(item => item.id === id)).filter(Boolean);
    const scroll = list.scrollTop;
    list.replaceChildren();
    if (!items.length) list.append(element('p', 'hint', '没有符合条件的资源。'));
    for (const item of items) {
      const card = element('article', 'workflow-card');
      card.append(element('h3', '', `${item.title}${item.paused ? ' · 已暂停' : ''}`), element('p', 'hint', [item.category || '未分类', item.connectionId ? '来自所选来源' : '手工登记', ...item.workflowIds.map(id => ws.workflows.find(flow => flow.id === id)?.title).filter(Boolean)].join(' · ')), element('p', 'path', item.path || item.content.slice(0, 180)));
      const open = button(item.kind === 'file' ? '在文件夹中显示' : '复制提示词', async () => {
        if (item.kind === 'file') await native('open_resource', { id: item.id });
        else { const { prompt } = await call('resourcePrompt', { id: item.id }); await native('plugin:clipboard-manager|write_text', { text: prompt }); }
        await mutate('resourceRecent', { id: item.id });
      }); open.disabled = item.paused;
      card.append(open, button(ws.favorites.includes(item.id) ? '取消收藏' : '收藏', () => mutate('resourceFavorite', { id: item.id, favorite: !ws.favorites.includes(item.id) })), button('编辑', () => editResource(item)), button(item.paused ? '恢复' : '暂停', () => mutate('resourcePause', { id: item.id, paused: !item.paused })));
      if (!item.connectionId) card.append(button('删除', async () => { if (window.confirm(`删除资源「${item.title}」？`)) await mutate('resourceDelete', { id: item.id }); }));
      list.append(card);
    }
    list.scrollTop = scroll;
  }
  subscribe(value => {
    view = value;
    issues.replaceChildren();
    if (value.workspaceError) issues.append(element('p', '', value.workspaceError));
    for (const issue of value.resourceCatalog?.issues || []) issues.append(element('p', '', `${issue.path}：${issue.issue}`));
    const key = JSON.stringify([value.workspace, value.resourceCatalog]);
    if (key === listKey) return; listKey = key;
    connections.replaceChildren();
    for (const connection of value.workspace?.connections || []) {
      const row = element('div', 'source-row'); row.append(element('span', 'path', connection.path), button('切换', () => editConnection(connection)), button('清空连接', () => mutate('resourceDisconnect', { id: connection.id }))); connections.append(row);
    }
    renderList();
  });
}
