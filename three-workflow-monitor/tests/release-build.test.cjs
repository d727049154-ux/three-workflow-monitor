'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build } = require('../tools/build.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '工作流 release '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = path.join(root, 'src-tauri');
  const registry = path.join(root, 'private-registry');
  const target = path.join(root, 'cargo target');
  const exe = path.join(target, 'release', 'workflow-monitor.exe');
  fs.mkdirSync(native, { recursive: true });
  fs.mkdirSync(registry);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(path.join(root, 'LICENSE'), 'Application license');
  fs.writeFileSync(path.join(native, 'HELP.md'), '用户帮助与恢复说明');
  fs.writeFileSync(path.join(registry, 'LICENSE-MIT'), 'Copyright component author\nMIT license text');
  fs.writeFileSync(path.join(root, 'sources.json'), 'private user source');
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64);
  fs.writeFileSync(exe, pe);
  const metadata = { target_directory: target, packages: [
    { id: 'app', name: 'workflow-monitor', version: '0.8.0', source: null, manifest_path: path.join(native, 'Cargo.toml') },
    { id: 'component', name: 'component', version: '1.0.0', source: 'registry', license: 'MIT', repository: 'https://example.test/component', manifest_path: path.join(registry, 'Cargo.toml') }
  ] };
  const artifact = { reason: 'compiler-artifact', package_id: 'app', target: { name: 'workflow-monitor', kind: ['bin'] }, executable: exe };
  const cargo = args => args[0] === 'metadata' ? JSON.stringify(metadata) : `${JSON.stringify({ reason: 'compiler-artifact', package_id: 'component' })}\n${JSON.stringify(artifact)}`;
  return { root, exe, cargo, metadata, artifact };
}

test('release packages a real executable, authoritative help and licenses only, including a rebuild of incomplete output', t => {
  const f = fixture(t);
  const out = path.join(f.root, 'dist', 'workflow-monitor');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'README.md'), 'incomplete old release');
  const result = build(f.root, f.cargo);
  assert.equal(result, out);
  assert.deepEqual(fs.readdirSync(out).sort(), ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.txt', 'workflow-monitor.exe']);
  assert.deepEqual(fs.readFileSync(path.join(out, 'workflow-monitor.exe')), fs.readFileSync(f.exe));
  assert.equal(fs.readFileSync(path.join(out, 'README.md'), 'utf8'), '用户帮助与恢复说明');
  const notices = fs.readFileSync(path.join(out, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(notices, /component 1.0.0/);
  assert.match(notices, /Copyright component author/);
  assert.ok(!notices.includes(f.root));
  fs.unlinkSync(path.join(out, 'workflow-monitor.exe'));
  build(f.root, f.cargo);
  assert.ok(fs.statSync(path.join(out, 'workflow-monitor.exe')).size > 0);
});

test('a successful Cargo exit without an executable artifact cannot reuse a stale file', t => {
  const f = fixture(t);
  assert.throws(() => build(f.root, args => args[0] === 'metadata' ? JSON.stringify(f.metadata) : ''), /产物/);
});

test('missing or invalid executable never produces a release directory', t => {
  const f = fixture(t);
  for (const content of [null, Buffer.alloc(0), Buffer.from('MZnot a PE executable')]) {
    if (content === null) fs.unlinkSync(f.exe); else fs.writeFileSync(f.exe, content);
    assert.throws(() => build(f.root, f.cargo), /可执行|ENOENT/);
    assert.ok(!fs.existsSync(path.join(f.root, 'dist', 'workflow-monitor')));
  }
});

test('failed Cargo build reports failure even when an old executable and package exist', t => {
  const f = fixture(t);
  build(f.root, f.cargo);
  assert.throws(() => build(f.root, () => { throw new Error('Cargo build failed'); }), /Cargo build failed/);
  assert.ok(!fs.existsSync(path.join(f.root, 'dist', 'workflow-monitor')));
});

test('missing component license fails packaging rather than publishing incomplete notices', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'private-registry', 'LICENSE-MIT'));
  assert.throws(() => build(f.root, f.cargo), /许可证/);
  assert.ok(!fs.existsSync(path.join(f.root, 'dist', 'workflow-monitor')));
});

test('an existing release folder with user data is preserved', t => {
  const f = fixture(t);
  const out = path.join(f.root, 'dist', 'workflow-monitor');
  fs.mkdirSync(path.join(out, 'user-data'), { recursive: true });
  fs.writeFileSync(path.join(out, 'user-data', 'workspace.json'), 'keep');
  assert.throws(() => build(f.root, f.cargo), /其他文件或数据/);
  assert.equal(fs.readFileSync(path.join(out, 'user-data', 'workspace.json'), 'utf8'), 'keep');
});

test('a failed executable integrity update rejects and removes the incomplete release', t => {
  const f = fixture(t);
  const out = path.join(f.root, 'dist', 'workflow-monitor');
  for (const failure of [{ status: 1, stderr: 'Access denied' }, { error: new Error('icacls unavailable') }]) {
    assert.throws(() => build(f.root, f.cargo, (command, args) => {
      assert.equal(command, 'icacls.exe');
      assert.equal(args[0], path.join(out, 'workflow-monitor.exe'));
      assert.ok(fs.existsSync(args[0]));
      return failure;
    }), /完整性标记/);
    assert.ok(!fs.existsSync(out));
  }
});

test('rebuilding under a low-integrity directory produces a medium-integrity desktop process', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), f.exe);
  const low = spawnSync('icacls.exe', [f.root, '/setintegritylevel', '(OI)(CI)L'], { encoding: 'utf8', windowsHide: true });
  assert.equal(low.status, 0, low.stderr || low.stdout);
  function processIntegrity(file) {
    const result = spawnSync(file, ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.match(/S-1-16-\d+/)?.[0];
  }
  assert.equal(processIntegrity(f.exe), 'S-1-16-4096', 'fixture must reproduce a low-integrity executable');
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = build(f.root, f.cargo);
    assert.equal(processIntegrity(path.join(out, 'workflow-monitor.exe')), 'S-1-16-8192');
  }
});
