import {activate} from './plugin/ui.mjs';
const bridge = window.workflowApp;
const byId = id => document.getElementById(id);
let state, latest, refreshing = false;
function error(message) {byId('desktop-error').textContent = message; byId('desktop-error').hidden = !message;}
async function command(name) {
  try {applyState(await bridge.command(name));} catch (issue) {error(issue.message);}
}
function applyState(value) {
  state = value;
  byId('pin').setAttribute('aria-pressed', String(value.alwaysOnTop));
  byId('pin').title = value.alwaysOnTop ? '当前已置顶，点击取消' : '点击置顶';
  byId('compact').textContent = value.compact ? '展开' : '收起';
  byId('compact').setAttribute('aria-label', value.compact ? '展开完整面板' : '收起为摘要');
  byId('panel').hidden = value.compact;
  byId('compact-panel').hidden = !value.compact;
  document.body.classList.toggle('is-compact', value.compact);
  if (value.error) error(value.error);
}
function receive(value) {
  if (!value?.snapshot) return;
  latest = value;
  const projects = value.snapshot.projects;
  const tasks = projects.reduce((count, project) => count + (project.tasks?.length || 0), 0);
  byId('compact-overview').textContent = `${projects.length} 条流程 · ${tasks} 项任务 · #${value.snapshot.id}`;
  const fragment = document.createDocumentFragment();
  for (const project of projects) {
    const row = document.createElement('button'); row.className = 'compact-flow'; row.type = 'button';
    const title = document.createElement('strong'); title.textContent = project.title;
    const status = document.createElement('span'); status.className = 'compact-state'; status.textContent = project.workflow?.stateLabel || project.stateLabel;
    const note = document.createElement('small'); note.textContent = `${project.tasks?.length || 0} 项关联任务 · ${project.phase || project.summary || '暂无最新记录'}`;
    row.append(title, status, note);
    row.addEventListener('click', async () => {
      if (state.compact) await command('compact');
      const live = [...document.querySelectorAll('.wm-nav button')].find(button => button.textContent === '实时');
      live?.click();
      const select = document.querySelector('select[aria-label="查看工作流"]');
      if (select) {select.value = project.id; select.dispatchEvent(new Event('change', {bubbles: true}));}
    });
    fragment.append(row);
  }
  byId('compact-flows').replaceChildren(fragment);
  byId('status-dot').classList.toggle('has-error', !!value.error);
  const time = new Date(value.checkedAt).toLocaleTimeString('zh-CN', {hour12: false});
  byId('status-text').textContent = value.error ? '部分来源待检查' : `${time} 已读取 · 15 秒更新`;
}
async function refresh() {
  if (refreshing) return;
  const button = document.querySelector('.wm-refresh');
  if (button) {button.click(); return;}
  refreshing = true; byId('compact-refresh').disabled = true;
  try {const result = await bridge.call('refreshAll'); receive(result.view);}
  catch (issue) {error(issue.message);}
  finally {refreshing = false; byId('compact-refresh').disabled = false;}
}
byId('pin').addEventListener('click', () => command('pin'));
byId('dock-show').addEventListener('click', () => command('dockShow'));
byId('compact').addEventListener('click', () => command('compact'));
byId('more').addEventListener('click', () => command('menu'));
byId('hide').addEventListener('click', () => command('hide'));
byId('compact-refresh').addEventListener('click', refresh);
const offState = bridge.onWindowState(applyState);
const offData = bridge.subscribe(receive);
const offError = bridge.onError(error);
const offAction = bridge.onAction(action => {if (action === 'refresh') refresh();});
try {
  applyState(await bridge.command('info'));
  const view = activate({backend: bridge}).mount(byId('app'), {surface: 'page'});
  receive(await bridge.call('current'));
  // The compact button mirrors the existing refresh state without another collector.
  const observer = new MutationObserver(() => {
    const button = document.querySelector('.wm-refresh');
    byId('compact-refresh').disabled = !!button?.disabled;
    byId('compact-refresh').textContent = button?.disabled ? '刷新中…' : '刷新';
  });
  observer.observe(byId('app'), {subtree: true, childList: true, attributes: true, attributeFilter: ['disabled']});
  addEventListener('pagehide', () => {observer.disconnect(); view.dispose(); offState(); offData(); offError(); offAction();}, {once: true});
} catch (issue) {error(issue.message); byId('status-text').textContent = '连接未完成，原有历史保留';}
