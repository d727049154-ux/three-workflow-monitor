'use strict';
// Development-only download. Package lifecycle scripts are never run.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const version = '7.5.0';
const integrity = 'sha512-sQtrEfA+ez/3G0cCZecF70oqpCRttCexYUG4mUrtWL49ULUzUyxokt5kyqwtKzj1270RaKih+hcP3qLcumccow==';
const url = `https://registry.npmjs.org/fuse.js/-/fuse.js-${version}.tgz`;
(async () => {
  const dir = path.join(root, 'vendor', `fuse-${version}`);
  await fs.mkdir(dir, {recursive: true});
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (`sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` !== integrity) throw new Error('Fuse package integrity mismatch');
  const archive = path.join(dir, `fuse.js-${version}.tgz`);
  await fs.writeFile(archive, bytes, {flag: 'wx'});
  const names = execFileSync('tar', ['-tf', archive], {encoding: 'utf8', windowsHide: true}).trim().split(/\r?\n/);
  const selected = {'package/dist/fuse.basic.min.mjs': `fuse.basic-${version}.min.mjs`, 'package/LICENSE': 'FUSE-LICENSE.txt'};
  const files = {};
  for (const [source, target] of Object.entries(selected)) {
    if (!names.includes(source)) throw new Error(`Package member missing: ${source}`);
    const content = execFileSync('tar', ['-xOf', archive, source], {maxBuffer: 1024 * 1024, windowsHide: true});
    await fs.writeFile(path.join(root, 'plugin', target), content, {flag: 'wx'});
    files[target] = {source, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex')};
  }
  const metadata = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], {encoding: 'utf8', windowsHide: true}));
  if (metadata.version !== version || metadata.license !== 'Apache-2.0') throw new Error('Unexpected Fuse metadata');
  const receipt = {name: 'fuse.js', version, license: metadata.license, source: 'https://github.com/krisk/Fuse/releases/tag/v7.5.0', url, integrity, fetchedAt: new Date().toISOString(), files};
  await fs.writeFile(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2), {flag: 'wx'});
  console.log(JSON.stringify(receipt, null, 2));
})().catch(error => {console.error(error.message); process.exitCode = 1;});
