'use strict';
// Copy only reviewed source files. Never export local profiles, connection lists or releases.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const TREES = ['desktop', 'plugin', 'tests', 'docs/github'];
const TREE_FILES = {
  desktop: ['active-tasks.cjs', 'contract.cjs', 'dock.css', 'dock.html', 'dock.mjs', 'dock-layout.cjs', 'index.html', 'main.cjs', 'package.json', 'preload.cjs', 'recent-task-feed.cjs', 'renderer.mjs', 'service.cjs', 'shell.css', 'shutdown.cjs', 'task-artifacts.cjs', 'task-dock.cjs', 'window-state.cjs', 'worker.cjs'],
  plugin: ['activity-ui.mjs', 'activity.cjs', 'backend.cjs', 'catalog-guide.cjs', 'catalog-ui.mjs', 'catalog.cjs', 'clipboard.mjs', 'core.cjs', 'defaults.json', 'fuse.basic-7.5.0.min.mjs', 'FUSE-LICENSE.txt', 'history.cjs', 'manager.cjs', 'manifest.json', 'panel.css', 'quick-ui.mjs', 'README.md', 'resources-ui.mjs', 'resources.cjs', 'search.mjs', 'targets.mjs', 'tasks.cjs', 'THIRD_PARTY.md', 'ui.mjs', 'workflows-ui.mjs', 'workflows.cjs', 'workspace.cjs'],
  tests: ['active-tasks.test.cjs', 'catalog.test.cjs', 'desktop.test.cjs', 'export-github.test.cjs', 'monitor.test.cjs', 'optimization.test.cjs', 'recent-task-feed.test.cjs', 'tasks.test.cjs'],
  'docs/github': ['README.md', 'defaults.json', 'STATUS.md']
};
const FILES = [
  'package.json',
  '打开预览.cmd', '打开预览.ps1', '停止预览.cmd', '停止预览.ps1',
  ...['build', 'build-desktop', 'freeze-desktop', 'desktop-history', 'preview', 'preview-control', 'preview-state', 'sample', 'vendor-fuse', 'ui-scenario', 'export-github'].map(name => `tools/${name}.cjs`),
  'vendor/NOTICE.md', 'vendor/TOKEN-MONITOR-LICENSE.txt', 'vendor/fuse-7.5.0/receipt.json',
  'vendor/token-monitor-0.86.0/package.json',
  ...['package', 'types', 'contracts'].map(name => `vendor/token-monitor-0.86.0/src/electron/plugins/${name}.js`),
  ...['manifest', 'settings', 'identityIcon', 'appearance', 'localized'].map(name => `vendor/token-monitor-0.86.0/src/shared/plugins/${name}.js`)
];
const OPTIONAL_FILES = ['package-lock.json', 'LICENSE', 'LICENSE.md'];
const GITIGNORE = `# Local observations, connection lists and generated packages\n/data/\n/qa/\n/connections/\n/delivery/\n/desktop-app/\n/node_modules/\n/desktop/node_modules/\n/desktop/deployment.json\n/desktop/plugin/\n/desktop/assets/\n.cache/\n*.lnk\n*.log\n.env\n.env.*\n!.env.example\n`;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
async function statOrNull(file) {
  try {return await fs.lstat(file);} catch (error) {if (error.code === 'ENOENT') return null; throw error;}
}
async function rejectLinkedAncestors(file) {
  let cursor = path.resolve(file);
  for (;;) {
    const stat = await statOrNull(cursor);
    if (stat?.isSymbolicLink()) throw new Error('路径包含符号链接或目录链接，拒绝导出');
    if (stat && cursor !== path.resolve(file) && !stat.isDirectory()) throw new Error('目标的父路径不是目录');
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
async function sourceFiles(sourceRoot) {
  const files = [];
  async function visit(relative) {
    const full = path.join(sourceRoot, relative);
    await rejectLinkedAncestors(full);
    const stat = await fs.lstat(full);
    if (!stat.isFile()) throw new Error('白名单来源必须是普通文件');
    files.push(relative);
  }
  for (const tree of TREES) {
    const directory = path.join(sourceRoot, tree);
    await rejectLinkedAncestors(directory);
    // Reject unexpected links without following or reading their contents.
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) if (entry.isSymbolicLink()) throw new Error('来源包含符号链接或目录链接，拒绝导出');
    for (const name of TREE_FILES[tree]) await visit(`${tree}/${name}`);
  }
  for (const file of FILES) {await visit(file);}
  for (const file of OPTIONAL_FILES) if (await statOrNull(path.join(sourceRoot, file))) await visit(file);
  return [...new Set(files)].sort();
}
function sanitizeTaskFixtures(bytes) {
  const mapped = new Map();
  return Buffer.from(bytes.toString('utf8').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, id => {
    const key = id.toLowerCase();
    if (!mapped.has(key)) mapped.set(key, `00000000-0000-4000-8000-${String(mapped.size + 1).padStart(12, '0')}`);
    return mapped.get(key);
  }));
}
async function exportGithub(target, {sourceRoot = root} = {}) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('请指定全新的导出目录');
  sourceRoot = path.resolve(sourceRoot); target = path.resolve(target);
  if (inside(sourceRoot, target) || inside(target, sourceRoot)) throw new Error('来源与目标不能相同或互相包含');
  await rejectLinkedAncestors(sourceRoot); await rejectLinkedAncestors(target);
  if (await statOrNull(target)) throw new Error('目标已经存在，拒绝覆盖或合并');
  const files = await sourceFiles(sourceRoot);
  // Read and validate everything before creating the destination.
  const contents = new Map();
  for (const file of files) contents.set(file, await fs.readFile(path.join(sourceRoot, file)));
  const defaults = contents.get('docs/github/defaults.json');
  const safeDefaults = JSON.parse(defaults);
  for (const [key, value] of Object.entries(safeDefaults)) {
    if (key === 'whiteRun' ? value !== 'default' : value !== '') throw new Error('公开默认配置应仅含空连接与 default 运行入口');
  }
  contents.set('plugin/defaults.json', defaults);
  contents.set('README.md', contents.get('docs/github/README.md'));
  contents.set('STATUS.md', contents.get('docs/github/STATUS.md'));
  contents.set('.gitignore', Buffer.from(GITIGNORE));
  if (contents.has('tests/tasks.test.cjs')) contents.set('tests/tasks.test.cjs', sanitizeTaskFixtures(contents.get('tests/tasks.test.cjs')));
  await fs.mkdir(path.dirname(target), {recursive: true});
  // mkdir without recursive is also the final race-safe no-overwrite check.
  await fs.mkdir(target);
  const records = [];
  for (const [relative, bytes] of [...contents].sort(([a], [b]) => a.localeCompare(b))) {
    const output = path.join(target, relative);
    await fs.mkdir(path.dirname(output), {recursive: true});
    await fs.writeFile(output, bytes, {flag: 'wx'});
    records.push({path: relative, bytes: bytes.length, sha256: sha256(bytes)});
  }
  const manifest = {schema: 'workflow-github-export/1', generatedAt: new Date().toISOString(), qualification: 'source-export-only', files: records};
  await fs.writeFile(path.join(target, 'EXPORT-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
  return {target, files: records.length, bytes: records.reduce((sum, file) => sum + file.bytes, 0), manifest: 'EXPORT-MANIFEST.json'};
}
if (require.main === module) {
  if (process.argv.length !== 3) {console.error('用法：node tools/export-github.cjs <全新目标目录>'); process.exitCode = 1;}
  else exportGithub(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {console.error(error.message); process.exitCode = 1;});
}
module.exports = {exportGithub, sourceFiles, sanitizeTaskFixtures, FILES, OPTIONAL_FILES, TREES, TREE_FILES};
