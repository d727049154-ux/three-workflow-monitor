'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {collect, sha, canonical, Reader, validateConfig} = require('../plugin/core.cjs');
const {History} = require('../plugin/history.cjs');
const {activate} = require('../plugin/backend.cjs');
const qa = path.resolve(__dirname, '../qa/tests');
async function fixture() {
  await fs.mkdir(qa, {recursive: true});
  const root = await fs.mkdtemp(path.join(qa, 'case-'));
  const whiteRoot = path.join(root, 'white'), eagleRoot = path.join(root, 'eagle'), carRoot = path.join(root, 'car');
  await Promise.all([fs.mkdir(path.join(whiteRoot, 'runs', 'pilot'), {recursive: true}), fs.mkdir(path.join(eagleRoot, 'commercial'), {recursive: true}), fs.mkdir(carRoot)]);
  await fs.writeFile(path.join(whiteRoot, 'runs/pilot/status.json'), JSON.stringify({updated: 1000, stages: {'build/S001': {state: 'complete'}}}));
  await fs.writeFile(path.join(whiteRoot, 'runs/pilot/events.jsonl'), JSON.stringify({event: 'complete', stage: 'build/S001', time: 1000}) + '\n');
  await fs.writeFile(path.join(eagleRoot, 'commercial/current-validation.json'), JSON.stringify({status: 'partial', goal_complete: false, blockers: {aesthetic_acceptance: 'Awaiting user review'}}));
  return {root, settings: {whiteRoot, whiteRun: 'pilot', eagleRoot, carRoot: '',taskLinksFile:'',codexSessionsRoot:''}, carRoot};
}
test('real pipeline cache completion never becomes visual acceptance or a full-film percentage', async () => {
  const f = await fixture(); const {projects} = await collect(f.settings);
  assert.equal(projects[1].state, 'recorded'); assert.equal(projects[1].progress, null);
  assert.match(projects[1].facts.join(' '), /此来源未提供/);
  assert.equal(projects[0].state, 'waiting'); assert.equal(projects[2].state, 'idle');
});
test('an old start event is shown as stale, not as currently running', async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.settings.whiteRoot, 'runs/pilot/events.jsonl'), JSON.stringify({event: 'start', stage: 'solve/S001', time: 1000}));
  const {projects} = await collect(f.settings); assert.equal(projects[1].state, 'stale');
});
test('generic completion requires explicit visual and user acceptance, and validates denominators', async () => {
  const f = await fixture(); f.settings.carRoot = f.carRoot;
  const file = path.join(f.carRoot, 'workflow-progress.json');
  const record = {schema: 'workflow-progress/1', state: 'complete', stage: '渲染', progress: {completed: 12, total: 10}};
  await fs.writeFile(file, JSON.stringify(record));
  let {projects} = await collect(f.settings); assert.equal(projects[2].state, 'produced'); assert.equal(projects[2].progress, null);
  await fs.writeFile(file, JSON.stringify({...record, acceptance: {visual: true, user: true}, progress: {completed: 10, total: 10, unit: '镜'}}));
  ({projects} = await collect(f.settings)); assert.equal(projects[2].state, 'accepted'); assert.equal(projects[2].progress.total, 10);
});
test('source files stay unchanged; changed snapshots archive exact previous bytes', async () => {
  const f = await fixture(); const file = path.join(f.settings.whiteRoot, 'runs/pilot/status.json');
  const original = await fs.readFile(file); const a = await collect(f.settings);
  const h = await new History(path.join(f.root, 'history')).init(); const first = await h.record(a.projects, a.evidence, 'change', f.settings);
  assert.equal(sha(await fs.readFile(file)), sha(original));
  const source = first.projects[1].sources.find(s => s.path === file);
  assert.equal(sha(await fs.readFile(path.join(f.root, 'history/evidence', `${source.sha256}.txt`))), sha(original));
  await fs.writeFile(file, JSON.stringify({updated: 2000, stages: {'build/S001': {state: 'complete'}, 'build/S002': {state: 'complete'}}}));
  const b = await collect(f.settings); const second = await h.record(b.projects, b.evidence, 'change', f.settings);
  assert.equal(second.previousHash, first.hash); assert.match((await h.read(1)).projects[1].facts[0], /1 项/); assert.match(second.projects[1].facts[0], /2 项/);
  assert.equal((await h.verify()).snapshots, 2);
});
test('refresh is deduplicated, explicit checkpoints persist, and history survives restart', async () => {
  const f = await fixture(); const a = await collect(f.settings); const dir = path.join(f.root, 'history');
  const h = await new History(dir).init();
  await h.record(a.projects, a.evidence, 'change', f.settings); await h.record(a.projects, a.evidence, 'change', f.settings);
  assert.equal(h.ids.length, 1);
  await h.record(a.projects, a.evidence, 'checkpoint', f.settings);
  const restored = await new History(dir).init(); assert.equal(restored.last.id, 2); assert.equal((await restored.list()).entries[0].reason, 'checkpoint');
  const exp = await restored.export(); const bundle = JSON.parse(await fs.readFile(exp.path, 'utf8'));
  assert.equal(bundle.entries.length, 2); assert.ok(Object.keys(bundle.evidence).length >= 3);
});
test('malformed current JSON is reported while previous history remains readable', async () => {
  const f = await fixture(); const a = await collect(f.settings); const h = await new History(path.join(f.root, 'history')).init();
  await h.record(a.projects, a.evidence, 'change', f.settings);
  await fs.writeFile(path.join(f.settings.whiteRoot, 'runs/pilot/status.json'), '{partial');
  const b = await collect(f.settings); assert.equal(b.projects[1].state, 'error');
  await h.record(b.projects, b.evidence, 'change', f.settings);
  assert.equal((await h.read(1)).projects[1].state, 'recorded'); assert.equal((await h.verify()).snapshots, 2);
});
test('tampered snapshots and source copies fail integrity checks without being overwritten', async () => {
  const f = await fixture(); const a = await collect(f.settings); const dir = path.join(f.root, 'history'); const h = await new History(dir).init();
  const first = await h.record(a.projects, a.evidence, 'change', f.settings);
  const source = first.projects[0].sources[0]; const file = path.join(dir, 'evidence', `${source.sha256}.txt`);
  await fs.writeFile(file, 'tampered'); await assert.rejects(h.verify(), /来源副本校验失败/);
  assert.equal(await fs.readFile(file, 'utf8'), 'tampered');
  const snap = {...first, observedAt: '2000-01-01T00:00:00Z'}; await fs.writeFile(h.file(1), JSON.stringify(snap));
  await assert.rejects(h.read(1), /校验失败/);
});
test('path traversal, invalid run names and oversized sources are rejected', async () => {
  const f = await fixture();
  await assert.rejects(validateConfig({...f.settings, whiteRun: '../outside'}), /运行入口/);
  await assert.rejects(validateConfig({...f.settings, carRoot: 'relative'}), /绝对/);
  await assert.rejects(new Reader().read(f.root, '../secret.json'), /超出/);
  await fs.writeFile(path.join(f.root, 'large.json'), Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.match((await new Reader().read(f.root, 'large.json')).error, /超过/);
});
test('backend serializes checkpoints, rejects stale configuration and releases its timer on disable', async () => {
  const f = await fixture(); const dataDirectory = path.join(f.root, 'backend'); await fs.mkdir(dataDirectory);
  await fs.writeFile(path.join(dataDirectory, 'config.json'), JSON.stringify({revision: 1, values: f.settings}));
  const publications = [];
  const backend = await activate({dataDirectory, publish: v => publications.push(v)});
  await Promise.all([backend.call('checkpoint'), backend.call('checkpoint')]);
  assert.equal((await backend.call('current')).totalSnapshots, 3);
  await assert.rejects(backend.call('configure', {expectedRevision: 0, values: f.settings}), /配置已更新/);
  await backend.dispose(); await assert.rejects(backend.call('current'), /停用/);
  const reloaded = await activate({dataDirectory}); assert.equal((await reloaded.call('current')).totalSnapshots, 3); await reloaded.dispose();
});
test('workflow construction is distinct from current execution; a car skill does not imply a completed job', async () => {
  const f = await fixture(); f.settings.carFlowRoot = path.join(f.root, 'car-skill');
  await fs.mkdir(f.settings.carFlowRoot); await fs.writeFile(path.join(f.settings.carFlowRoot, 'SKILL.md'), '# 汽车复刻流程\n');
  const {projects} = await collect(f.settings); const car = projects[2];
  assert.equal(car.workflow.defined, true); assert.equal(car.workflow.stages.length, 6); assert.equal(car.state, 'idle');
  assert.ok(car.workflow.stages.every(stage => stage.state === 'defined'));
  assert.equal(car.progress, null); assert.ok(car.sources.some(s => s.role === '汽车动画复刻工作流规范'));
});
test('parallel construction reads have deterministic ordering and do not create duplicate history', async () => {
  const f = await fixture(); f.settings.carFlowRoot = path.join(f.root, 'car-skill');
  await fs.mkdir(path.join(f.settings.carFlowRoot, 'references'), {recursive: true}); await fs.mkdir(path.join(f.settings.carFlowRoot, 'assets'));
  await fs.writeFile(path.join(f.settings.carFlowRoot, 'SKILL.md'), '# Workflow'); await fs.writeFile(path.join(f.settings.carFlowRoot, 'references/shot-plan.md'), '# Shots'); await fs.writeFile(path.join(f.settings.carFlowRoot, 'assets/render-job.template.json'), '{}');
  const h = await new History(path.join(f.root, 'history')).init();
  let fingerprint;
  for (let i = 0; i < 8; i++) {const result = await collect(f.settings); const actual = sha(canonical(result.projects)); if (fingerprint) assert.equal(actual, fingerprint); fingerprint = actual; await h.record(result.projects, result.evidence, 'change', f.settings);}
  assert.equal(h.ids.length, 1);
});
