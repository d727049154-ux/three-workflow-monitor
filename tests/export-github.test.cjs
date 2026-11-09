'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {exportGithub, FILES, TREES, TREE_FILES} = require('../tools/export-github.cjs');
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-public-export-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const source = path.join(temp, 'source'); await fs.mkdir(source);
  const put = async (name, bytes) => {const file = path.join(source, name); await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, bytes);};
  for (const tree of TREES) await fs.mkdir(path.join(source, tree), {recursive: true});
  for (const [tree, names] of Object.entries(TREE_FILES)) for (const name of names) await put(`${tree}/${name}`, name.endsWith('.json') ? '{}\n' : 'source\n');
  for (const name of FILES) await put(name, name.endsWith('.json') ? '{}\n' : 'source\n');
  await put('docs/github/defaults.json', JSON.stringify({eagleRoot: '', whiteRun: 'default', codexSessionsRoot: ''}));
  await put('docs/github/README.md', '# Public instructions\n'); await put('docs/github/STATUS.md', '# Boundaries\n');
  await put('plugin/defaults.json', JSON.stringify({eagleRoot: 'PRIVATE_PROJECT', taskLinksFile: 'PRIVATE_CHAT_LIST'}));
  await put('plugin/core.cjs', 'module.exports = {};\n');
  await put('desktop/main.cjs', 'source desktop\n');
  await put('tests/tasks.test.cjs', "const id='12345678-1234-4234-8234-123456789012'; const same='12345678-1234-4234-8234-123456789012'; const other='87654321-1234-4234-8234-123456789012';\n");
  for (const name of ['connections/linked-tasks.json', 'data/private.json', 'qa/private.json', 'delivery/private.json', 'desktop-app/private.json', 'README.md', '验收记录.md', 'private.lnk']) await put(name, 'PRIVATE_SENTINEL');
  return {temp, source, put, target: path.join(temp, 'public')};
}
test('public export uses an allowlist, sanitizes fixtures and verifies every manifest hash', async t => {
  const f = await fixture(t); const result = await exportGithub(f.target, {sourceRoot: f.source});
  assert.ok(result.files > 20);
  const manifestText = await fs.readFile(path.join(f.target, 'EXPORT-MANIFEST.json'), 'utf8');
  assert.ok(!manifestText.includes(f.source)); assert.ok(!manifestText.includes(f.target));
  const manifest = JSON.parse(manifestText);
  for (const item of manifest.files) {
    assert.ok(!path.isAbsolute(item.path)); assert.ok(!item.path.includes('..'));
    const bytes = await fs.readFile(path.join(f.target, item.path)); assert.equal(bytes.length, item.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), item.sha256);
    assert.doesNotMatch(bytes.toString('utf8'), /PRIVATE_SENTINEL|PRIVATE_PROJECT|PRIVATE_CHAT_LIST/);
  }
  assert.equal(await fs.readFile(path.join(f.target, 'README.md'), 'utf8'), '# Public instructions\n');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.target, 'plugin/defaults.json'))), {eagleRoot: '', whiteRun: 'default', codexSessionsRoot: ''});
  const tasks = await fs.readFile(path.join(f.target, 'tests/tasks.test.cjs'), 'utf8');
  assert.doesNotMatch(tasks, /12345678|87654321/);
  assert.equal((tasks.match(/00000000-0000-4000-8000-000000000001/g) || []).length, 2);
  assert.match(tasks, /00000000-0000-4000-8000-000000000002/);
  for (const name of ['connections', 'data', 'qa', 'delivery', 'desktop-app', 'private.lnk']) await assert.rejects(fs.lstat(path.join(f.target, name)), {code: 'ENOENT'});
  assert.match(await fs.readFile(path.join(f.target, '.gitignore'), 'utf8'), /\/connections\//);
  const again = path.join(f.temp, 'again'); await exportGithub(again, {sourceRoot: f.target});
  assert.equal(await fs.readFile(path.join(again, 'tests/tasks.test.cjs'), 'utf8'), tasks);
});
test('existing and nested destinations are refused without touching original files', async t => {
  const f = await fixture(t); await fs.mkdir(f.target); await fs.writeFile(path.join(f.target, 'keep'), 'keep');
  await assert.rejects(exportGithub(f.target, {sourceRoot: f.source}), /已经存在/);
  assert.equal(await fs.readFile(path.join(f.target, 'keep'), 'utf8'), 'keep');
  await assert.rejects(exportGithub(path.join(f.source, 'nested'), {sourceRoot: f.source}), /互相包含/);
  await assert.rejects(exportGithub(f.temp, {sourceRoot: f.source}), /互相包含/);
  await assert.rejects(exportGithub(f.source, {sourceRoot: f.source}), /互相包含/);
});
test('linked source entries and linked destination ancestors are refused before export', async t => {
  const f = await fixture(t); const outside = path.join(f.temp, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.source, 'plugin', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(exportGithub(f.target, {sourceRoot: f.source}), /链接/);
  await assert.rejects(fs.lstat(f.target), {code: 'ENOENT'});
  const destinationLink = path.join(f.temp, 'linked-target'); await fs.symlink(outside, destinationLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(exportGithub(path.join(destinationLink, 'export'), {sourceRoot: f.source}), /链接/);
});
test('generated desktop additions are excluded and unsafe public defaults abort before writing', async t => {
  const f = await fixture(t);
  await f.put('desktop/deployment.json', 'PRIVATE_SENTINEL'); await f.put('desktop/plugin/local.cjs', 'PRIVATE_SENTINEL'); await f.put('desktop/assets/icon.png', 'PRIVATE_SENTINEL');
  await f.put('plugin/.env', 'PRIVATE_SENTINEL'); await f.put('desktop/private.json', 'PRIVATE_SENTINEL'); await f.put('tests/private.txt', 'PRIVATE_SENTINEL');
  await f.put('docs/github/defaults.json', JSON.stringify({eagleRoot: 'PRIVATE_PROJECT', whiteRun: 'default'}));
  await assert.rejects(exportGithub(f.target, {sourceRoot: f.source}), /公开默认配置/);
  await assert.rejects(fs.lstat(f.target), {code: 'ENOENT'});
  await f.put('docs/github/defaults.json', JSON.stringify({eagleRoot: '', whiteRun: 'default'}));
  await exportGithub(f.target, {sourceRoot: f.source});
  for (const name of ['desktop/deployment.json', 'desktop/plugin', 'desktop/assets', 'plugin/.env', 'desktop/private.json', 'tests/private.txt']) await assert.rejects(fs.lstat(path.join(f.target, name)), {code: 'ENOENT'});
});
