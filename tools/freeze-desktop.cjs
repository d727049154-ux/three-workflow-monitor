'use strict';
const fs=require('node:fs/promises');
const sync=require('node:fs');
const path=require('node:path');
const {inventory}=require('./build-desktop.cjs');
const {canonical}=require('../plugin/core.cjs');
const root=path.resolve(__dirname,'..');
async function freeze(version,verificationFile) {
  if(!/^\d+\.\d+\.\d+$/.test(version||''))throw new Error('版本号无效');
  const output=path.join(root,'delivery',`desktop-v${version}`);
  if(sync.existsSync(output))throw new Error('冻结目录已经存在，原件不覆盖');
  const qa=path.join(root,'qa','desktop-installation');
  const receipts=[];
  for(const name of (await fs.readdir(qa)).filter(name=>/^build-\d+\.json$/.test(name))) {
    const receipt=JSON.parse(await fs.readFile(path.join(qa,name),'utf8'));
    if(receipt.version===version)receipts.push({receipt,file:path.join(qa,name)});
  }
  receipts.sort((a,b)=>b.receipt.builtAt.localeCompare(a.receipt.builtAt));
  const latest=receipts[0];if(!latest)throw new Error('没有对应构建收据');
  const appRoot=path.join(root,'desktop-app',`v${version}`);
  if(path.resolve(latest.receipt.appRoot).toLowerCase()!==appRoot.toLowerCase())throw new Error('收据程序目录不匹配');
  const observed=await inventory(appRoot);
  const actual=observed.filter(item=>item.path!=='debug.log');
  if(canonical(actual)!==canonical(latest.receipt.files))throw new Error('程序与构建收据不同，暂不冻结');
  let verification;
  if(verificationFile){
    verification=JSON.parse(await fs.readFile(path.resolve(verificationFile),'utf8'));
    if(verification.schema!=='workflow-desktop-native-verification/1'||verification.version!==version||verification.passed!==true||
      path.resolve(verification.buildReceipt).toLowerCase()!==path.resolve(latest.file).toLowerCase())throw new Error('原生验收收据与本次构建不匹配');
  }
  await fs.mkdir(output);
  await fs.cp(path.join(appRoot,'resources','app'),path.join(output,'source'),{recursive:true,errorOnExist:true,force:false});
  const frozen=await inventory(path.join(output,'source'));
  const expected=actual.filter(item=>item.path.startsWith('resources/app/')).map(item=>({...item,path:item.path.slice('resources/app/'.length)}));
  if(canonical(frozen)!==canonical(expected))throw new Error('冻结源码与程序不一致');
  const record={...latest.receipt,schema:'workflow-desktop-release/1',qualification:'native-validation-incomplete',frozenAt:new Date().toISOString(),buildReceipt:latest.file,sourceFiles:frozen,excludedRuntimeLogs:observed.filter(item=>item.path==='debug.log')};
  if(verification)Object.assign(record,{qualification:'native-validation-passed',verificationFile:path.resolve(verificationFile)});
  await fs.writeFile(path.join(output,'release.json'),JSON.stringify(record,null,2),{flag:'wx'});
  return {version,output,files:actual.length,sourceFiles:frozen.length,qualification:record.qualification};
}
if(require.main===module)freeze(process.argv[2],process.argv[3]).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={freeze};
