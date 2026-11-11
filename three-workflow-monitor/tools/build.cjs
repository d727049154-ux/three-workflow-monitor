'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const product = path.resolve(__dirname, '..');

function cargo(args, cwd) {
  const result = spawnSync('cargo', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cargo ${args[0]} 失败（${result.status ?? '未完成'}）`);
  return result.stdout;
}
function executable(file) {
  const bytes = fs.readFileSync(file);
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0;
  if (bytes.toString('ascii', 0, 2) !== 'MZ' || pe < 64 || pe > bytes.length - 4 || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') {
    throw new Error('构建产物不是有效的 Windows 可执行文件');
  }
}
function desktopIntegrity(file, runIcacls) {
  // A Low label inherited from a development folder prevents normal AppData writes.
  const result = runIcacls('icacls.exe', [file, '/setintegritylevel', 'M'], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`无法设置发行程序完整性标记：${result.error.message}`);
  if (result.status !== 0) throw new Error(`发行程序完整性标记设置失败（${result.status ?? '未完成'}）：${(result.stderr || result.stdout || '').trim()}`);
}
function notices(root, packages) {
  const supplement = path.join(root, 'tools', 'licenses');
  const overridesFile = path.join(supplement, 'overrides.json');
  const overrides = fs.existsSync(overridesFile) ? JSON.parse(fs.readFileSync(overridesFile, 'utf8')) : {};
  const sections = ['第三方组件许可证与版权声明\n包含本次 Windows 构建使用的 Rust 组件及构建工具。\nWebView2 由系统提供，其许可由 Microsoft 随运行时提供。'];
  for (const pkg of packages.filter(pkg => pkg.source).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
    const dir = path.dirname(pkg.manifest_path);
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && /^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(entry.name)).map(entry => path.join(dir, entry.name));
    if (pkg.license_file) {
      const file = path.resolve(dir, pkg.license_file);
      if (!file.startsWith(dir + path.sep)) throw new Error(`${pkg.name} 许可证路径越界`);
      if (!files.includes(file)) files.push(file);
    }
    const override = overrides[`${pkg.name}@${pkg.version}`];
    if (override) for (const file of override.files) files.push(path.join(supplement, file));
    if (!files.length) throw new Error(`${pkg.name} ${pkg.version} 缺少许可证原文，请补入 tools/licenses`);
    sections.push(`${pkg.name} ${pkg.version}\nLicense: ${pkg.license || '见下文'}\nSource: ${pkg.repository || `https://crates.io/crates/${pkg.name}/${pkg.version}`}\n${pkg.authors?.length ? `Authors: ${pkg.authors.join(', ')}\n` : ''}${override ? `License sources: ${override.sources.join(', ')}\n` : ''}\n${files.map(file => fs.readFileSync(file, 'utf8')).join('\n\n')}`);
  }
  return sections.join('\n\n========================================\n\n') + '\n';
}
const releaseFiles = ['workflow-monitor.exe', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'];
function clearRelease(release) {
  for (const dir of [path.dirname(release), release]) {
    if (fs.existsSync(dir) && (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())) throw new Error('发行目录必须是普通目录');
  }
  if (!fs.existsSync(release)) return;
  const entries = fs.readdirSync(release, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() || !releaseFiles.includes(entry.name))) throw new Error('发行目录包含其他文件或数据，请移至其他目录后重试');
  for (const entry of entries) fs.unlinkSync(path.join(release, entry.name));
  fs.rmdirSync(release);
}
function build(root = product, runCargo = cargo, runIcacls = spawnSync) {
  root = path.resolve(root);
  const release = path.join(root, 'dist', 'workflow-monitor');
  if (!release.startsWith(root + path.sep)) throw new Error('发行目录越界');
  clearRelease(release);
  const native = path.join(root, 'src-tauri');
  const output = runCargo(['build', '--locked', '--release', '--message-format=json-render-diagnostics'], native);
  const messages = output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const artifact = messages.find(message => message.reason === 'compiler-artifact' && message.target?.name === 'workflow-monitor' && message.target.kind.includes('bin') && message.executable);
  if (!artifact) throw new Error('Cargo 未返回应用可执行产物');
  const metadata = JSON.parse(runCargo(['metadata', '--locked', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc'], native));
  const expected = path.join(metadata.target_directory, 'release', 'workflow-monitor.exe');
  if (path.resolve(artifact.executable) !== path.resolve(expected)) throw new Error('应用可执行产物路径与 Cargo 目标目录不一致');
  executable(expected);
  const used = new Set(messages.filter(message => message.reason === 'compiler-artifact').map(message => message.package_id));
  const licenses = notices(root, metadata.packages.filter(pkg => used.has(pkg.id)));
  const help = fs.readFileSync(path.join(native, 'HELP.md'));
  const license = fs.readFileSync(path.join(root, 'LICENSE'));
  fs.mkdirSync(release, { recursive: true });
  try {
    const releasedExe = path.join(release, 'workflow-monitor.exe');
    fs.copyFileSync(expected, releasedExe);
    desktopIntegrity(releasedExe, runIcacls);
    fs.writeFileSync(path.join(release, 'README.md'), help);
    fs.writeFileSync(path.join(release, 'LICENSE'), license);
    fs.writeFileSync(path.join(release, 'THIRD_PARTY_NOTICES.txt'), licenses);
  } catch (error) {
    clearRelease(release);
    throw error;
  }
  return release;
}
module.exports = { build };
if (require.main === module) {
  try { console.log(`发行包已生成：${build()}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
