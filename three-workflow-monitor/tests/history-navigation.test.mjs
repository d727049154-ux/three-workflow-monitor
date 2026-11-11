import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryNavigation } from '../frontend/history.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const pending = new Map(); const visible = [];
  const nav = createHistoryNavigation({
    load: (method, args) => { const request = deferred(); pending.set(args.id || method, request); return request.promise; },
    show: (mode, value) => visible.push({ mode, value }),
    fail: error => visible.push({ error }),
  });
  return { nav, pending, visible };
}
test('returning to live wins over a delayed snapshot and its error', async () => {
  const { nav, pending, visible } = fixture();
  const old = nav.snapshot('old'); nav.live(); pending.get('old').resolve({ id: 'old' }); await old;
  assert.deepEqual(visible, [{ mode: 'live', value: undefined }]);
  const failure = nav.snapshot('bad'); nav.live(); pending.get('bad').reject(new Error('late')); await failure;
  assert.equal(visible.at(-1).mode, 'live'); assert.equal(visible.length, 2);
});
test('last snapshot, returning to list, and unloading invalidate earlier requests', async () => {
  const { nav, pending, visible } = fixture();
  const first = nav.snapshot('first'); const second = nav.snapshot('second');
  pending.get('second').resolve({ id: 'second' }); await second;
  pending.get('first').resolve({ id: 'first' }); await first;
  assert.deepEqual(visible, [{ mode: 'snapshot', value: { id: 'second' } }]);
  const old = nav.snapshot('old'); const list = nav.list();
  pending.get('historyList').resolve({ items: [] }); await list;
  pending.get('old').resolve({ id: 'old' }); await old;
  assert.deepEqual(visible.at(-1), { mode: 'list', value: { items: [] } });
  const abandoned = nav.snapshot('abandoned'); nav.dispose();
  pending.get('abandoned').resolve({ id: 'abandoned' }); await abandoned;
  assert.equal(visible.length, 2);
});


test('reopening retained history invalidates a pending request without rebuilding its reading content', async () => {
  const { nav, pending, visible } = fixture();
  const snapshot = nav.snapshot('saved'); pending.get('saved').resolve({ id: 'saved' }); await snapshot;
  nav.live();
  const obsolete = nav.list();
  nav.restore('snapshot');
  pending.get('historyList').resolve({ items: ['obsolete'] }); await obsolete;
  assert.equal(nav.isLive, false);
  assert.deepEqual(visible, [{ mode: 'snapshot', value: { id: 'saved' } }, { mode: 'live', value: undefined }]);
});
