import { call, native, notify, element } from './bridge.mjs';
import { taskArtifacts } from './history.mjs';
const labels = { unknown: '执行状态待同步', inProgress: '正在推进', completed: '回合已结束', failed: '执行失败', interrupted: '已中断', waiting: '需要介入', paused: '已暂停', pending: '尚未开始' };
let selected = null;
let view;
let candidateHost;
const mounted = new WeakMap();
const statusText = task => `${task.sourceHealth?.state !== 'ok' || task.progress?.workflowPaused ? '上次确认：' : ''}${labels[task.execution] || task.execution}`;
function button(text, action, className = '') {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', () => Promise.resolve().then(action).catch(error => notify(String(error))));
  return node;
}
async function addSource(kind, refresh) {
  const path = await native('pick_source');
  if (!path) return;
  if (kind === 'progress') {
    await call('configureSources', { expectedRevision: view.sourcesRevision, sources: [...view.sources, { id: crypto.randomUUID(), kind, path }] });
    await refresh();
    return;
  }
  const candidates = await call('discoverSources', { path });
  candidateHost.replaceChildren(element('h3', '', '选择要观察的聊天'));
  if (!candidates.length) candidateHost.append(element('p', 'hint', '这个目录中没有可核验的 Codex 聊天。请选择包含 JSONL 会话文件的目录。'));
  for (const candidate of candidates) {
    const row = button(candidate.title || candidate.threadId, async () => {
      await call('configureSources', { expectedRevision: view.sourcesRevision, sources: [...view.sources, { ...candidate, id: crypto.randomUUID(), kind, path }] });
      candidateHost.replaceChildren();
      await refresh();
    }, 'candidate');
    row.append(element('small', '', `${candidate.projectRoot} · ${candidate.threadId}`));
    candidateHost.append(row);
  }
  candidateHost.append(button('取消', () => candidateHost.replaceChildren()));
}
function detail(task) {
  const panel = element('article', 'task-detail');
  panel.append(element('h3', '', task.title), element('p', 'path', task.projectRoot), element('p', `status ${task.execution}`, statusText(task)));
  if (task.progress?.workflowTitle) panel.append(element('p', 'hint', `工作流：${task.progress.workflowTitle}${task.progress.workflowPaused ? ' · 已暂停观察' : ''}`));
  if (task.stageId) panel.append(element('p', 'hint', task.progress?.stageStatus === 'known' ? `阶段：${task.progress.stageLabel}` : `阶段：未知或已删除（${task.stageId}）`));
  if (task.sourceHealth.state !== 'ok') panel.append(element('p', 'hint', task.sourceHealth.issue || '正在顺序补读，状态仍待同步'));
  panel.append(element('p', 'hint', task.acceptance === 'accepted' ? '来源明确登记：成果已验收' : '成果验收：未登记'));
  for (const message of task.messages) {
    const entry = element('section', 'message');
    entry.append(element('small', '', `${message.phase === 'commentary' ? '公开进展' : '公开答复'} · ${message.at || '来源时间未登记'}`), element('p', '', message.text));
    panel.append(entry);
  }
  if (!task.messages.length) panel.append(element('p', 'hint', '还没有公开文字进展。工具内容与推理不显示在这里。'));
  panel.append(element('p', 'path', `来源：${task.sourcePath}`), element('p', 'hint task-time', `来源事件：${task.eventAt || '未登记'} · 观察：${task.observedAt}`), button(task.threadId ? '打开原聊天' : '打开项目目录', () => native('open_task', { id: task.sourceId })));
  panel.append(taskArtifacts(task));
  return panel;
}
export function renderObservation(container, value, refresh) {
  view = value;
  const dock = document.body.dataset.view === 'dock';
  let state = mounted.get(container);
  if (!state) {
    state = { rows: new Map(), sources: new Map(), detail: null };
    mounted.set(container, state);
    const intro = element('section', 'panel onboarding');
    if (!dock) intro.append(element('h1', '', '观察你的工作'), element('p', 'hint', '选择本机来源后，查看真实任务和公开进展。'), button('接入 Codex 聊天', () => addSource('codex', refresh), 'primary'), button('接入项目进度', () => addSource('progress', refresh)));
    else intro.append(element('p', 'hint', '从完整面板接入来源'), button('打开面板', () => native('window_action', { action: 'main' })));
    candidateHost = element('section', 'candidates');
    container.append(intro, candidateHost, element('div', 'source-list'), element('div', 'task-list'), element('div', 'detail-host'));
  }
  container.querySelector('.onboarding').hidden = dock ? value.sources.length > 0 : false;
  const sourceList = container.querySelector('.source-list');
  sourceList.hidden = dock;
  const sourceKey = JSON.stringify(value.sources.map(source => source.id));
  for (const source of value.sources) {
    if (state.sources.has(source.id)) continue;
    const row = element('div', 'source-row');
    const name = element('input'); name.value = source.title || ''; name.maxLength = 160; name.placeholder = '来源显示名称'; name.setAttribute('aria-label', '来源显示名称');
    const editor = { row, name, revision: undefined };
    const discard = button('放弃修改', () => { editor.revision = undefined; renderObservation(container, view, refresh); });
    discard.hidden = true;
    name.addEventListener('input', () => { editor.revision ??= view.sourcesRevision; discard.hidden = false; });
    editor.discard = discard;
    row.append(element('span', 'path', `${source.kind === 'codex' ? '聊天' : '项目'} · ${source.path}`), name, button('保存名称', async () => {
      await call('configureSources', { expectedRevision: editor.revision ?? view.sourcesRevision, sources: view.sources.map(item => item.id === source.id ? { ...item, title: name.value.trim() || null } : item) });
      editor.revision = undefined; discard.hidden = true; await refresh();
    }), discard, button('移除', async () => { await call('configureSources', { expectedRevision: view.sourcesRevision, sources: view.sources.filter(item => item.id !== source.id) }); await refresh(); }), element('p', 'source-issue error'));
    state.sources.set(source.id, editor);
  }
  if (state.sourceKey !== sourceKey) { sourceList.replaceChildren(...value.sources.map(source => state.sources.get(source.id).row)); state.sourceKey = sourceKey; }
  for (const source of value.sources) {
    const editor = state.sources.get(source.id);
    if (editor.revision === undefined) { editor.name.value = source.title || ''; editor.discard.hidden = true; }
    editor.row.querySelector('.source-issue').textContent = value.sourceHealth.find(item => item.sourceId === source.id)?.issue || '';
  }
  for (const id of state.sources.keys()) if (!value.sources.some(source => source.id === id)) state.sources.delete(id);
  if (!value.tasks.some(task => task.id === selected)) selected = value.tasks[0]?.id || null;
  const list = container.querySelector('.task-list');
  const ordered = [...value.tasks].sort((a, b) => rank(a) - rank(b) || String(b.eventAt || '').localeCompare(String(a.eventAt || '')));
  function rank(task) { if (task.sourceHealth?.state !== 'ok' || task.progress?.workflowPaused) return 3; return ['waiting', 'failed'].includes(task.execution) ? 0 : task.execution === 'inProgress' ? 1 : ['completed', 'interrupted'].includes(task.execution) ? 2 : 3; }
  for (const task of ordered) {
    let row = state.rows.get(task.id);
    if (!row) {
      row = button('', () => { selected = task.id; if (dock && document.body.dataset.expanded !== 'true') native('window_action', { action: 'expand' }).catch(error => notify(String(error))); renderObservation(container, view, refresh); }, 'task-card');
      row.append(element('span', 'dot'), element('strong', 'task-title'), element('small', 'task-state'));
      state.rows.set(task.id, row);
    }
    row.className = `task-card ${selected === task.id ? 'selected' : ''}`;
    row.setAttribute('aria-pressed', String(selected === task.id));
    row.querySelector('.dot').className = `dot ${task.sourceHealth?.state === 'ok' && !task.progress?.workflowPaused ? task.execution : 'unknown'}`;
    row.querySelector('.task-title').textContent = task.title;
    row.querySelector('.task-state').textContent = statusText(task);
    row.title = `${task.title} · ${statusText(task)}`;
  }
  const orderKey = ordered.map(task => `${rank(task)}:${task.id}`).join('|');
  if (state.orderKey !== orderKey) {
    const focus = document.activeElement;
    let group; const nodes = [];
    for (const task of ordered) { const next = rank(task); if (group !== next) { nodes.push(element('h2', 'task-group', ['需要介入', '正在推进', '最近结束', '执行待同步'][next])); group = next; } nodes.push(state.rows.get(task.id)); }
    list.replaceChildren(...nodes);
    if (ordered.some(task => state.rows.get(task.id) === focus)) focus.focus({ preventScroll: true });
    state.orderKey = orderKey;
  }
  for (const id of state.rows.keys()) if (!value.tasks.some(task => task.id === id)) state.rows.delete(id);
  const task = value.tasks.find(item => item.id === selected);
  const host = container.querySelector('.detail-host');
  // Observation timestamps change on every poll; they do not invalidate the reading DOM.
  const key = JSON.stringify(task ? { ...task, observedAt: undefined, sourceHealth: { ...task.sourceHealth, observedAt: undefined } } : null);
  if (state.detailId !== task?.id) {
    host.replaceChildren(...(task ? [detail(task)] : [])); state.detailId = task?.id; state.detailKey = key;
  } else if (state.detailKey !== key && task) {
    const next = detail(task); const existing = host.querySelector('.task-detail');
    // Keep the article and its scroll position. Only changed evidence replaces its children.
    const focus = document.activeElement; const focusIndex = [...existing.querySelectorAll('button')].indexOf(focus);
    const expanded = [...existing.querySelectorAll('details')].map(node => node.open);
    existing.replaceChildren(...next.children);
    existing.querySelectorAll('details').forEach((node, index) => { node.open = expanded[index] || false; });
    if (focusIndex >= 0) existing.querySelectorAll('button')[focusIndex]?.focus({ preventScroll: true });
    state.detailKey = key;
  }
  if (task) host.querySelector('.task-time').textContent = `来源事件：${task.eventAt || '未登记'} · 观察：${task.observedAt}`;
}
