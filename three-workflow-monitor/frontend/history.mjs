import { call, native, element, notify } from './bridge.mjs';

// Every navigation intent, including live/list and unloading, invalidates older responses.
export function createHistoryNavigation({ load, show, fail, change = () => {} }) {
  let intent = 0;
  let mode = 'live';
  let disposed = false;
  async function navigate(next, method, args) {
    if (disposed) return;
    const request = ++intent;
    mode = next; change(next);
    try {
      const value = await load(method, args);
      if (!disposed && request === intent) show(next, value);
    } catch (error) {
      if (!disposed && request === intent) fail(error);
    }
  }
  return {
    get isLive() { return mode === 'live'; },
    live() { if (disposed) return; ++intent; mode = 'live'; change(mode); show(mode); },
    restore(next) { if (disposed) return; ++intent; mode = next; change(mode); },
    list(beforeId = null) { return navigate('list', 'historyList', { beforeId, limit: 25 }); },
    snapshot(id) { return navigate('snapshot', 'historySnapshot', { id }); },
    dispose() { disposed = true; ++intent; },
  };
}
function button(text, action) {
  const node = element('button', '', text); node.type = 'button';
  node.addEventListener('click', () => Promise.resolve().then(action).catch(error => notify(String(error))));
  return node;
}
const labels = { completed: '回合已结束', inProgress: '正在推进', waiting: '需要介入', unknown: '执行待同步', failed: '执行失败', interrupted: '已中断', paused: '已暂停', pending: '尚未开始' };
const fields = { sources: '观察来源', sourceHealth: '来源健康', title: '任务名称', execution: '执行状态', acceptance: '成果验收', eventAt: '来源事件时间', messages: '公开文字', workflowId: '工作流关联', stageId: '阶段关联', progress: '阶段信息', removed: '移出当前任务' };
function changedValue(field, value) {
  if (value === null || value === undefined) return '未登记';
  if (field === 'messages') return `${value.length} 条公开文字（内容见当时证据）`;
  if (field === 'sources') return value.map(source => source.title || source.path).join('；') || '未接入';
  if (field === 'sourceHealth') return value.map(source => source.issue || (source.state === 'ok' ? '来源可读' : '来源正在补读')).join('；') || '尚未观察';
  if (field === 'acceptance') return value === 'accepted' ? '来源明确登记已验收' : '验收未登记';
  if (field === 'execution') return labels[value] || value;
  if (field === 'progress') return [value.workflowTitle, value.stageLabel, value.stageStatus === 'removed' ? '阶段已删除或未知' : ''].filter(Boolean).join(' · ') || '未关联阶段';
  return String(value);
}

export function taskArtifacts(task, snapshotId) {
  const panel = element('section', 'message');
  panel.append(element('h3', '', '当前可访问文件'), element('p', 'hint', snapshotId
    ? '以下入口来自当时记录的公开文件引用，检查的是现在的文件。没有归档文件内容，不代表快照时的文件版本。'
    : '仅提取公开进展中的文件引用，不扫描整个工程，不代表成果已验收。'));
  const list = element('div'); panel.append(list);
  async function update() {
    const value = await call('artifacts', { taskId: task.id, snapshotId });
    if (!panel.isConnected) return;
    list.replaceChildren();
    if (!value.items.length) list.append(element('p', 'hint', '尚无公开文件引用。可在公开答复或进度说明中用 Markdown 链接或行内代码注明文件路径。'));
    for (const item of value.items) {
      const row = element('p', 'path');
      row.append(element('span', '', `${item.reference} · ${item.available ? '当前可访问' : item.issue}`));
      if (item.available) row.append(button('在文件夹中显示', () => native('open_artifact', { taskId: task.id, snapshotId, id: item.id })));
      list.append(row);
    }
  }
  panel.append(button('重新检查文件', update));
  Promise.resolve().then(update).catch(error => { if (panel.isConnected) list.textContent = String(error); });
  return panel;
}

export function mountHistory(container, subscribe, refresh, showLive, onMode) {
  const section = element('section', 'panel workflows');
  const toolbar = element('nav'); toolbar.setAttribute('aria-label', '实时与历史');
  const content = element('div'); const status = element('p', 'error');
  const selected = new Set();
  let latest;
  let retainedMode;
  let pageBefore = null;
  const previousPages = new Map();
  function showList(page) {
    pageBefore = page.beforeId;
    content.replaceChildren(element('h2', '', '历史观察'), element('p', 'hint', '记录当时观察到的公开进展、执行状态与来源健康；回合结束和成果验收分别记录。'));
    content.append(element('p', 'hint', '导出范围：仅明确勾选的快照、公开进展和状态变化。包含公开文字与本机路径；不含资源正文、工作区提示词或文件内容。'));
    const exportButton = button(`导出所选（${selected.size}）`, async () => {
      const result = await native('export_history', { ids: [...selected] });
      if (!result.cancelled) notify(`已导出 ${result.count} 份观察：${result.path}`);
    });
    exportButton.disabled = !selected.size; content.append(exportButton);
    if (!page.items.length) content.append(element('p', 'hint', '还没有历史观察。接入来源并刷新后会记录变化，也可以手动保存当前观察。'));
    for (const item of page.items) {
      const row = element('div', 'workflow-card'); const choice = element('label');
      const check = element('input'); check.type = 'checkbox'; check.checked = selected.has(item.id);
      check.addEventListener('change', () => { if (check.checked) selected.add(item.id); else selected.delete(item.id); exportButton.textContent = `导出所选（${selected.size}）`; exportButton.disabled = !selected.size; });
      choice.append(check, document.createTextNode(` ${item.kind === 'checkpoint' ? '手动保存' : '状态变化'} · ${item.observedAt}`));
      row.append(choice, element('p', 'hint', `${item.taskCount} 条任务 · ${item.changeCount} 项变化 · ${item.acknowledged ? '已读' : '未读'}`), button('查看当时观察', () => navigation.snapshot(item.id)));
      content.append(row);
    }
    const previous = button('上一页', () => navigation.list(previousPages.get(page.beforeId)));
    const next = button('下一页', () => { previousPages.set(page.nextBefore, page.beforeId); return navigation.list(page.nextBefore); });
    previous.disabled = !page.beforeId; next.disabled = !page.nextBefore;
    content.append(previous, element('span', 'hint', ` ${page.total} 份观察 `), next);
  }
  function showSnapshot(record) {
    const snapshot = record.snapshot;
    content.replaceChildren(button('返回历史列表', () => navigation.list(pageBefore)), element('h2', '', '当时观察到的状态'), element('p', 'hint', `观察时间：${snapshot.observedAt}。公开证据与状态按当时记录保留，文件内容没有归档。`));
    content.append(button('标记已读', async () => { await call('historyAcknowledge', { id: record.id }); notify('已标记已读'); }));
    const changes = element('details'); changes.append(element('summary', '', `变化与来源依据（${record.changes.length}）`));
    for (const change of record.changes) {
      const title = snapshot.tasks.find(task => task.id === change.taskId)?.title;
      changes.append(element('p', 'path', `${title ? `${title} · ` : ''}${fields[change.field] || change.field}：${changedValue(change.field, change.before)} → ${changedValue(change.field, change.after)}`));
    }
    for (const source of snapshot.sources) changes.append(element('p', 'path', `当时来源：${source.title || source.kind} · ${source.path}`));
    content.append(changes);
    const tasks = element('div', 'task-list'); const detail = element('div'); content.append(tasks, detail);
    function select(task) {
      detail.replaceChildren(element('h3', '', task.title), element('p', 'status', labels[task.execution] || task.execution), element('p', 'hint', task.acceptance === 'accepted' ? '当时来源明确登记：成果已验收' : '当时成果验收：未登记'), element('p', 'hint', `来源事件：${task.eventAt || '未登记'} · 观察：${task.observedAt}`));
      if (task.progress?.workflowTitle) detail.append(element('p', 'hint', `当时工作流：${task.progress.workflowTitle} · ${task.progress.stageLabel || task.stageId || '未分配阶段'}`));
      if (task.sourceHealth.state !== 'ok') detail.append(element('p', 'error', task.sourceHealth.issue || task.sourceHealth.state));
      for (const message of task.messages) { const entry = element('section', 'message'); entry.append(element('small', '', `当时公开文字 · ${message.at || '来源时间未登记'}`), element('p', '', message.text)); detail.append(entry); }
      const recordedSource = snapshot.sources.find(source => source.id === task.sourceId);
      if (recordedSource && latest?.sources.some(source => ['id', 'kind', 'path', 'sessionFile', 'threadId', 'projectRoot'].every(key => (source[key] ?? null) === (recordedSource[key] ?? null)))) detail.append(button(task.threadId ? '打开原聊天' : '打开当前项目目录', () => native('open_task', { id: task.sourceId })));
      detail.append(taskArtifacts(task, record.id));
    }
    for (const task of snapshot.tasks) tasks.append(button(task.title, () => select(task)));
    if (snapshot.tasks.length) select(snapshot.tasks[0]); else detail.append(element('p', 'hint', '当时没有当前任务；来源身份和健康记录仍保留。'));
  }
  const navigation = createHistoryNavigation({
    load: call,
    change(mode) {
      if (onMode) onMode(mode);
      else for (const id of ['observation', 'workflows', 'resources']) { const node = document.getElementById(id); if (node) node.hidden = mode !== 'live'; }
      content.hidden = mode === 'live';
    },
    show(mode, value) { if (mode !== 'live') retainedMode = mode; status.textContent = latest?.historyError || ''; if (mode === 'live') showLive(); else if (mode === 'list') showList(value); else showSnapshot(value); },
    fail(error) { status.textContent = String(error); },
  });
  toolbar.append(button('实时任务', () => navigation.live()), button('历史观察', () => navigation.list()), button('保存当前观察', async () => { await call('historyCheckpoint'); await refresh(); notify('已保存当前观察，可在历史列表查看'); }), button('校验历史', async () => { const result = await call('historyVerify'); notify(`历史校验通过：${result.recordCount} 条记录`); }));
  section.append(toolbar, status, content); container.append(section); content.hidden = true;
  const unsubscribe = subscribe(value => { latest = value; status.textContent = value.historyError || ''; });
  window.addEventListener('pagehide', () => { navigation.dispose(); unsubscribe(); }, { once: true });
  navigation.reopen = () => retainedMode ? navigation.restore(retainedMode) : navigation.list();
  return navigation;
}
