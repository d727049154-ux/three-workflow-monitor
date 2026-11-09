'use strict';
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const desktop = path.join(root, 'desktop');
const runtime = path.resolve(process.env.WORKFLOW_ELECTRON_DIST || path.join(root,'node_modules','electron','dist'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function inventory(directory, prefix = '') {
  const items = [];
  for (const entry of (await fs.readdir(directory, {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('安装包不接受符号链接');
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) items.push(...await inventory(path.join(directory, entry.name), relative));
    else {const bytes = await fs.readFile(path.join(directory, entry.name)); items.push({path: relative, bytes: bytes.length, sha256: hash(bytes)});}
  }
  return items;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {crc ^= byte; for (let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc ^ 0xffffffff) >>> 0;
}
function png(size) {
  const rgba = Buffer.alloc(size * (size*4+1));
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const px=(x+.5)/size*64, py=(y+.5)/size*64;
    const ix = Math.max(8,Math.min(56,px)), iy = Math.max(8,Math.min(56,py));
    const inside=(px-ix)**2+(py-iy)**2<=64;
    const offset=y*(size*4+1)+1+x*4;
    let color=[48,65,52,inside?255:0];
    for(const [row,width] of [[17,33],[30,25],[43,17]]) if(px>=15&&px<15+width&&py>=row&&py<row+5)color=[206,225,193,255];
    rgba.set(color,offset);
  }
  function chunk(type, bytes) {const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(bytes.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,bytes])));return Buffer.concat([length,name,bytes,checksum]);}
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(rgba)),chunk('IEND',Buffer.alloc(0))]);
}
async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(desktop,'package.json'),'utf8'));
  if (!sync.existsSync(path.join(runtime,'version'))) {
    throw new Error([
      `找不到可用的 Electron 运行时：${runtime}\n`,
      '处理方式（任选一种）：\n',
      '  1. 在项目根目录执行 npm ci；若依赖包已安装但运行时缺失，执行 node node_modules/electron/install.js 补下载（需要网络）；\n',
      '  2. 设置 WORKFLOW_ELECTRON_DIST 指向已有的同版本官方 Electron 目录，该目录需包含 electron.exe 与 version。\n',
      `要求版本：${pkg.runtime.electron}`
    ].join(''));
  }
  const runtimeVersion = (await fs.readFile(path.join(runtime,'version'),'utf8')).trim();
  if (runtimeVersion !== pkg.runtime.electron) throw new Error(`本机 Electron 版本与记录不一致：需要 ${pkg.runtime.electron}，实际 ${runtimeVersion}`);
  const appRoot = path.join(root,'desktop-app',`v${pkg.version}`);
  const release = path.join(root,'delivery',`desktop-v${pkg.version}`);
  if (sync.existsSync(path.join(release,'release.json'))) throw new Error('此独立版已冻结；请升版后构建');
  const liveFile=path.join(root,'data','desktop-profile','runtime.json');
  if(sync.existsSync(liveFile)) {
    const live=JSON.parse(await fs.readFile(liveFile,'utf8'));
    if(!live.stoppedAt&&live.version===pkg.version)throw new Error('请先从独立面板菜单退出，再更新当前运行版本的程序文件');
  }
  const runtimeCopied = !sync.existsSync(appRoot);
  if (runtimeCopied) {
    await fs.mkdir(appRoot,{recursive:true});
    for (const name of await fs.readdir(runtime)) {
      await fs.cp(path.join(runtime,name),path.join(appRoot,name==='electron.exe'?'工作流观察.exe':name),{recursive:true,errorOnExist:true,force:false});
    }
  }
  const app = path.join(appRoot,'resources','app');
  await fs.mkdir(app,{recursive:true});
  for (const item of await inventory(desktop)) {
    await fs.mkdir(path.dirname(path.join(app,item.path)),{recursive:true});
    await fs.copyFile(path.join(desktop,item.path),path.join(app,item.path));
  }
  await fs.mkdir(path.join(app,'plugin'),{recursive:true});
  const manifest = JSON.parse(await fs.readFile(path.join(root,'plugin','manifest.json'),'utf8'));
  for (const name of ['manifest.json',...manifest.files]) {
    let bytes=await fs.readFile(path.join(root,'plugin',name));
    // Compile the desktop release label; original plugin and frozen .tmplugin stay untouched.
    if(name==='ui.mjs') {
      const contents=bytes.toString('utf8');
      if((contents.match(/v0\.5\.0 ·/g)||[]).length!==2)throw new Error('界面版本标记已变化，请核对后构建');
      bytes=Buffer.from(contents.replaceAll('v0.5.0 ·',`v${pkg.version} ·`));
    }
    await fs.writeFile(path.join(app,'plugin',name),bytes);
  }
  await fs.writeFile(path.join(app,'deployment.json'),JSON.stringify({schema:'workflow-desktop-deployment/1',projectRelative:'../../../..',mode:'portable-local',version:pkg.version},null,2));
  await fs.mkdir(path.join(app,'assets'),{recursive:true});
  await fs.writeFile(path.join(app,'assets','icon.png'),png(128));
  await fs.writeFile(path.join(app,'assets','tray.png'),png(32));
  const icon=png(256),ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico[10]=1;ico[12]=32;ico.writeUInt32LE(icon.length,14);ico.writeUInt32LE(22,18);
  await fs.writeFile(path.join(app,'assets','icon.ico'),Buffer.concat([ico,icon]));
  const files=(await inventory(appRoot)).filter(item=>item.path!=='debug.log');
  const receipt={schema:'workflow-desktop-build/1',version:pkg.version,builtAt:new Date().toISOString(),appRoot,executable:path.join(appRoot,'工作流观察.exe'),runtime:{version:runtimeVersion,source:runtime,exeSha256:hash(await fs.readFile(path.join(runtime,'electron.exe')))},files};
  const out=path.join(root,'qa','desktop-installation');await fs.mkdir(out,{recursive:true});
  const receiptFile=path.join(out,`build-${Date.now()}.json`);await fs.writeFile(receiptFile,JSON.stringify(receipt,null,2),{flag:'wx'});
  if(process.argv.includes('--freeze')) {
    await fs.mkdir(release,{recursive:true});
    await fs.cp(app,path.join(release,'source'),{recursive:true,errorOnExist:true,force:false});
    await fs.writeFile(path.join(release,'release.json'),JSON.stringify({...receipt,qualification:'native-validation-incomplete',buildReceipt:receiptFile},null,2),{flag:'wx'});
  }
  console.log(JSON.stringify({version:pkg.version,executable:receipt.executable,files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),runtimeCopied,receipt:receiptFile,frozen:process.argv.includes('--freeze')},null,2));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={inventory};
