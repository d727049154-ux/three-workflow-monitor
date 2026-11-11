'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 检查失败（${result.status ?? '未完成'}）`);
}
try {
  run('cargo', ['test', '--locked'], path.join(root, 'src-tauri'));
  const tests = fs.readdirSync(path.join(root, 'tests')).filter(file => /\.test\.(?:mjs|cjs)$/.test(file)).sort().map(file => path.join(root, 'tests', file));
  run(process.execPath, ['--test', ...tests], root);
} catch (error) { console.error(error.message); process.exitCode = 1; }
