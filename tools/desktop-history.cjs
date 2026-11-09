'use strict';
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const {History} = require('../plugin/history.cjs');
const {sha, canonical, inside} = require('../plugin/core.cjs');
const root = path.resolve(__dirname,'..');
const retained = new Set(['snapshots','evidence','catalog','manager','exports','workspace-history','workspace.json','config.json','active-task-history']);
async function retainedFiles(directory, prefix='') {
  const files=[];
  for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(!prefix&&!retained.has(entry.name))continue;
    if(entry.isSymbolicLink())throw new Error('历史目录包含链接，已停止接续');
    const name=prefix?`${prefix}/${entry.name}`:entry.name;
    if(name.includes('.pending-'))throw new Error('历史仍有未提交写入，请先完整退出观察');
    if(entry.isDirectory())files.push(...await retainedFiles(path.join(directory,entry.name),name));
    else {const bytes=await fs.readFile(path.join(directory,entry.name));files.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}
  }
  return files;
}
async function copyHistory(source, target, receiptFile) {
  source=await fs.realpath(source);target=path.resolve(target);
  if(inside(source,target)||inside(target,source))throw new Error('来源与目标不能互相包含');
  if(sync.existsSync(target))throw new Error('目标数据目录已经存在，拒绝覆盖或合并历史');
  const history=await new History(source).init();const integrity=await history.verify();
  const activeRoot=path.join(source,'active-task-history');
  const activeIntegrity=sync.existsSync(activeRoot)?await (await new History(activeRoot).init()).verify():null;
  const files=await retainedFiles(source);
  if(!files.length)throw new Error('来源没有可接续记录');
  const record={schema:'workflow-desktop-history-copy/1',startedAt:new Date().toISOString(),source,target,integrity,activeIntegrity,files,status:'prepared'};
  await fs.mkdir(path.dirname(receiptFile),{recursive:true});
  await fs.writeFile(receiptFile,JSON.stringify(record,null,2),{flag:'wx'});
  try {
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.mkdir(target);
    for(const file of files) {
      const from=path.join(source,file.path),to=path.join(target,file.path);
      if(!inside(source,from)||!inside(target,to))throw new Error('历史路径超出范围');
      const bytes=await fs.readFile(from);if(sha(bytes)!==file.sha256)throw new Error('接续过程中来源发生变化，原件已保留');
      await fs.mkdir(path.dirname(to),{recursive:true});await fs.writeFile(to,bytes,{flag:'wx'});
      if(sha(await fs.readFile(to))!==file.sha256)throw new Error('接续副本校验失败');
    }
    if(canonical(await retainedFiles(source))!==canonical(files))throw new Error('接续过程中来源目录有变化，请核对记录');
    const copied=await new History(target).init();const result=await copied.verify();
    if(result.headHash!==integrity.headHash||result.snapshots!==integrity.snapshots)throw new Error('新旧历史链不一致');
    if(activeIntegrity){
      const activeCopy=await (await new History(path.join(target,'active-task-history')).init()).verify();
      if(activeCopy.headHash!==activeIntegrity.headHash||activeCopy.snapshots!==activeIntegrity.snapshots)throw new Error('侧边任务新旧历史链不一致');
    }
    Object.assign(record,{status:'completed',completedAt:new Date().toISOString(),verifiedFiles:files.length,sourcePreserved:true});
  } catch(error) {Object.assign(record,{status:'incomplete',error:error.message});throw error;}
  finally {await fs.writeFile(receiptFile,JSON.stringify(record,null,2));}
  return {source,target,receipt:receiptFile,snapshots:integrity.snapshots,sources:integrity.sources,activeIntegrity,files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),headHash:integrity.headHash};
}
async function main() {
  const action=process.argv[2]||'seed';
  if(action==='seed') {
    const {readRecord}=require('./preview-state.cjs');const preview=await readRecord();
    if(preview&&!preview.stoppedAt)throw new Error('请先用 preview-control.cjs stop 停止真实预览，再接续历史');
    const result=await copyHistory(path.join(root,'qa','preview-profile'),path.join(root,'data','desktop-profile','data'),path.join(root,'qa','desktop-installation',`history-seed-${Date.now()}.json`));
    console.log(JSON.stringify(result,null,2));
  } else if(action==='recovery-preview') {
    const runtime=JSON.parse(await fs.readFile(path.join(root,'data','desktop-profile','runtime.json'),'utf8'));
    if(!runtime.stoppedAt)throw new Error('请先从独立面板菜单选择“退出观察”，等待历史保存后再恢复');
    const profile=`desktop-recovery-${Date.now()}`;
    const result=await copyHistory(path.join(root,'data','desktop-profile','data'),path.join(root,'qa','profiles',profile),path.join(root,'qa','desktop-installation',`history-recovery-${Date.now()}.json`));
    console.log(JSON.stringify({...result,profile,startCommand:`node tools/preview-control.cjs start --profile ${profile} --no-open`},null,2));
  } else throw new Error('操作仅支持 seed / recovery-preview');
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={copyHistory,retainedFiles};
