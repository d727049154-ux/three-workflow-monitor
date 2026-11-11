import { call, native, notify } from './bridge.mjs';
import { renderObservation } from './observation.mjs';
import { mountWorkflows } from './workflows.mjs';
import { mountResources } from './resources.mjs';
import { mountHistory } from './history.mjs';
let latest;
let pending;
let historyView;
let selectedPanel = 'observation';
const positions = new Map();
const focusByPanel = new Map();
const dock = document.body.dataset.view === 'dock';
const listeners = new Set();
export function subscribe(listener) { listeners.add(listener); if (latest) listener(latest); return () => listeners.delete(listener); }
export function refresh() {
  if (pending) return pending;
  pending = call('refresh').then(value => {
    latest = value;
    if (!historyView || historyView.isLive) renderObservation(document.getElementById('observation'), value, refresh);
    document.getElementById('observed').textContent = `观察于 ${new Date(value.observedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
    for (const listener of listeners) listener(value);
    return value;
  }).catch(error => notify(String(error))).finally(() => { pending = null; });
  return pending;
}
function showPanel(panel) {
  if (panel !== selectedPanel) {
    positions.set(selectedPanel, window.scrollY);
    if (document.getElementById(selectedPanel)?.contains(document.activeElement)) focusByPanel.set(selectedPanel, document.activeElement);
  }
  selectedPanel = panel;
  for (const id of ['observation', 'workflows', 'resources']) {
    const node = document.getElementById(id); if (node) node.hidden = id !== selectedPanel || !historyView?.isLive;
  }
  for (const button of document.querySelectorAll('[data-panel]')) button.setAttribute('aria-current', button.dataset.panel === panel ? 'page' : 'false');
  requestAnimationFrame(() => { window.scrollTo(0, positions.get(panel) || 0); const node = focusByPanel.get(panel); if (node?.isConnected) node.focus({ preventScroll: true }); });
}
document.addEventListener('focusin', event => { const panel = event.target.closest('#observation, #workflows, #resources, #history'); if (panel) focusByPanel.set(panel.id, event.target); });
for (const button of document.querySelectorAll('[data-panel]')) button.addEventListener('click', () => {
  const panel = button.dataset.panel;
  if (panel === 'history') { showPanel(panel); if (historyView.isLive) historyView.reopen(); if (dock && document.body.dataset.expanded !== 'true') windowAction('expand').catch(error => notify(String(error))); }
  else { showPanel(panel); historyView.live(); }
});
document.getElementById('refresh').addEventListener('click', refresh);
document.addEventListener('keydown', event => {
  if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')) { event.preventDefault(); refresh(); }
});
async function windowAction(action) { await native('window_action', { action }); }
function presentWindow(value) {
  const p = value.presentation;
  document.body.dataset.compact = String(p.compact); document.body.dataset.expanded = String(p.expanded);
  const pin = document.getElementById('pin'); if (pin) { pin.setAttribute('aria-pressed', String(p.pinned)); pin.textContent = p.pinned ? '取消置顶' : '置顶'; }
  const compact = document.getElementById('compact'); if (compact) { compact.setAttribute('aria-pressed', String(p.compact)); compact.textContent = p.compact ? '完整' : '摘要'; }
  const expand = document.getElementById('expand'); if (expand) { expand.setAttribute('aria-expanded', String(p.expanded)); expand.textContent = p.expanded ? '收起' : '展开'; }
  if (p.compact && historyView) { historyView.live(); showPanel('observation'); }
  if (value.warning) notify(`窗口位置无法保存：${value.warning}`);
}
for (const button of document.querySelectorAll('[data-window-action]')) button.addEventListener('click', () => windowAction(button.dataset.windowAction).catch(error => notify(String(error))));
document.querySelector('.shell-header').addEventListener('mousedown', event => {
  if (event.button === 0 && !event.target.closest('button')) native('window_action', { action: 'drag' }).catch(error => notify(String(error)));
});
native('window_action', { action: 'state' }).then(presentWindow).catch(error => notify(String(error)));
window.__TAURI__.event.listen('window-presentation', event => presentWindow(event.payload)).catch(error => notify(String(error)));

document.getElementById('show-dock')?.addEventListener('click', () => native('window_action', { action: 'dock' }).catch(error => notify(String(error))));
document.getElementById('close').addEventListener('click', () => native('window_action', { action: 'close' }).catch(error => notify(String(error))));
mountWorkflows(document.getElementById('workflows'), subscribe, refresh);
mountResources(document.getElementById('resources'), subscribe, refresh);
historyView = mountHistory(document.getElementById('history'), subscribe, refresh, () => { if (latest) renderObservation(document.getElementById('observation'), latest, refresh); }, mode => {
  if (mode !== 'live') { if (selectedPanel !== 'history') showPanel('history'); }
  else { if (selectedPanel === 'history') showPanel('observation'); for (const id of ['observation', 'workflows', 'resources']) { const node = document.getElementById(id); if (node) node.hidden = id !== selectedPanel; } }
});
showPanel('observation');
refresh();
setInterval(refresh, 5000);
