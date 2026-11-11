import test from 'node:test';
import assert from 'node:assert/strict';
import { renderObservation } from '../frontend/observation.mjs';

// DOM is the browser boundary; retain real renderer/controller code in this test.
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.className = ''; this.textContent = ''; this.listeners = {}; this.scrollTop = 0; this.isConnected = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(name, action) { this.listeners[name] = action; }
  querySelector(query) { return this.querySelectorAll(query)[0] || null; }
  querySelectorAll(query) { return this.children.flatMap(node => [...((query.startsWith('.') ? node.className.split(' ').includes(query.slice(1)) : node.tagName === query) ? [node] : []), ...node.querySelectorAll(query)]); }
  focus() { document.activeElement = this; }
}
const notice = new Node('p');
globalThis.document = { getElementById: id => id === 'notice' ? notice : null, createElement: tag => new Node(tag), activeElement: null, body: { dataset: { view: 'main' } } };
globalThis.window = { __TAURI__: { core: { invoke: async () => ({ items: [] }) } } };
const view = () => ({ sources: [], sourceHealth: [], tasks: [{ id: 'one', sourceId: 'source', title: '准备译稿', execution: 'inProgress', sourceHealth: { state: 'ok', observedAt: 'first' }, observedAt: 'first', messages: [], acceptance: 'unknown' }] });

test('polling retains the focused task button, expanded detail and reading position', () => {
  const container = new Node('section'); const first = view();
  renderObservation(container, first, () => {});
  const button = container.querySelector('.task-card'); const detail = container.querySelector('.task-detail');
  button.focus(); detail.scrollTop = 160;
  const second = view(); second.tasks[0].observedAt = 'second'; second.tasks[0].sourceHealth.observedAt = 'second';
  renderObservation(container, second, () => {});
  assert.equal(container.querySelector('.task-card'), button);
  assert.equal(document.activeElement, button);
  assert.equal(container.querySelector('.task-detail'), detail);
  assert.equal(detail.scrollTop, 160);
});

test('unreadable or catching-up sources present last confirmed execution, never as currently running', () => {
  const container = new Node('section'); const value = view();
  value.tasks[0].sourceHealth.state = 'error';
  renderObservation(container, value, () => {});
  assert.match(container.querySelector('.task-card').querySelector('.task-state').textContent, /上次确认/);
  value.tasks[0].sourceHealth.state = 'catchingUp';
  renderObservation(container, value, () => {});
  assert.match(container.querySelector('.task-card').querySelector('.task-state').textContent, /上次确认/);
});

const sourceView = (revision, title) => ({ ...view(), sourcesRevision: revision, sources: [{ id: 'source', kind: 'progress', path: 'C:/project/progress.json', title }] });
const sourceButton = (container, title) => container.querySelector('.source-row').querySelectorAll('button').find(node => node.textContent === title);

test('a source name draft keeps its editing revision through polling and reports a conflicting save', async () => {
  const container = new Node('section'); let refreshed = false; let submitted;
  notice.textContent = '';
  window.__TAURI__.core.invoke = async (command, payload) => {
    assert.equal(command, 'backend_call'); assert.equal(payload.method, 'configureSources');
    submitted = payload.args;
    if (submitted.expectedRevision !== 'revision-2') throw new Error('来源配置已被其他窗口修改，请刷新后重试');
  };
  renderObservation(container, sourceView('revision-1', '原名称'), () => { refreshed = true; });
  const input = container.querySelector('input');
  input.value = '本窗口草稿'; input.listeners.input?.();
  renderObservation(container, sourceView('revision-2', '另一窗口名称'), () => { refreshed = true; });
  assert.equal(container.querySelector('input'), input);
  assert.equal(input.value, '本窗口草稿');
  await sourceButton(container, '保存名称').listeners.click();
  assert.equal(submitted.expectedRevision, 'revision-1');
  assert.equal(submitted.sources[0].title, '本窗口草稿');
  assert.match(notice.textContent, /其他窗口/);
  assert.equal(input.value, '本窗口草稿');
  assert.equal(refreshed, false);
  await sourceButton(container, '保存名称').listeners.click();
  assert.equal(submitted.expectedRevision, 'revision-1');
});

test('polling updates a source name when there is no local draft', () => {
  const container = new Node('section');
  renderObservation(container, sourceView('revision-1', '原名称'), () => {});
  const input = container.querySelector('input'); input.focus();
  renderObservation(container, sourceView('revision-2', '另一窗口名称'), () => {});
  assert.equal(container.querySelector('input'), input);
  assert.equal(input.value, '另一窗口名称');
  assert.equal(document.activeElement, input);
});

test('a successful source name save refreshes and ends the local draft', async () => {
  const container = new Node('section'); let submitted; let refreshed = false;
  window.__TAURI__.core.invoke = async (command, payload) => { submitted = payload.args; };
  renderObservation(container, sourceView('revision-3', '原名称'), () => {
    refreshed = true;
    renderObservation(container, sourceView('revision-4', '已保存名称'), () => {});
  });
  const input = container.querySelector('input');
  input.value = '  已保存名称  '; input.listeners.input?.();
  await sourceButton(container, '保存名称').listeners.click();
  assert.equal(submitted.expectedRevision, 'revision-3');
  assert.equal(submitted.sources[0].title, '已保存名称');
  assert.equal(refreshed, true);
  assert.equal(input.value, '已保存名称');
  renderObservation(container, sourceView('revision-5', '后续外部名称'), () => {});
  assert.equal(input.value, '后续外部名称');
});

test('discarding a source name draft restores the latest name and revision', async () => {
  const container = new Node('section'); let submitted;
  window.__TAURI__.core.invoke = async (command, payload) => { submitted = payload.args; };
  renderObservation(container, sourceView('revision-1', '原名称'), () => {});
  const input = container.querySelector('input');
  input.value = '待放弃草稿'; input.listeners.input?.();
  renderObservation(container, sourceView('revision-2', '另一窗口名称'), () => {});
  const discard = sourceButton(container, '放弃修改');
  assert.ok(discard, 'drafts need a visible way to return to the current name');
  assert.equal(discard.hidden, false);
  await discard.listeners.click();
  assert.equal(input.value, '另一窗口名称');
  assert.equal(discard.hidden, true);
  input.value = '新的修改'; input.listeners.input?.();
  await sourceButton(container, '保存名称').listeners.click();
  assert.equal(submitted.expectedRevision, 'revision-2');
  assert.equal(submitted.sources[0].title, '新的修改');
});
