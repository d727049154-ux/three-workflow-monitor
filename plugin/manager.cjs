'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {canonical,sha,nowIso} = require('./core.cjs');
const run=promisify(execFile);
const normal=value=>path.resolve(value).toLocaleLowerCase();
const strings=value=>Array.isArray(value)?value.filter(x=>typeof x==='string').slice(0,80):[];
async function hashSkill(file){const stat=await fs.stat(file);if(!stat.isFile()||stat.size>1024*1024)throw new Error('Skill 文件超出上限');return sha(await fs.readFile(file));}
class SkillsManager {
  constructor(dataDirectory,runner=run){this.root=dataDirectory;this.run=runner;this.value=null;this.checked=0;this.managerRoot=null;}
  async get(managerRoot,force=false){
    if(this.value&&this.managerRoot===managerRoot&&!force&&Date.now()-this.checked<60000)return this.value;
    this.checked=Date.now();this.managerRoot=managerRoot;
    if(!managerRoot)return {connected:false,issue:'未设置 Skills Manager 目录',skills:[]};
    try{
      const cli=path.join(managerRoot,'bin','skills-manager-cli.exe');
      const stamp=(await fs.readFile(path.join(managerRoot,'bin','.version'),'utf8')).trim();
      if(!stamp||!(await fs.stat(cli)).isFile())throw new Error('CLI 桥不完整，请打开 Skills Manager 修复桥接');
      const query=async args=>{const value=await this.run(cli,['--json',...args],{windowsHide:true,shell:false,timeout:15000,maxBuffer:4*1024*1024,encoding:'utf8'});return JSON.parse(value.stdout);};
      const repo=await query(['repo','status']);
      if(normal(repo.base_dir)!==normal(managerRoot)||normal(repo.skills_dir)!==normal(path.join(managerRoot,'skills')))throw new Error('当前运行账户与 Skills Manager 所属账户不一致；请从本机桌面启动预览');
      const [skills,agents,presets]=await Promise.all([query(['skills','list']),query(['agents','list']),query(['presets','list'])]);
      if(!Array.isArray(skills)||skills.length>1000||!Array.isArray(agents)||!Array.isArray(presets))throw new Error('Skills Manager 返回的目录格式不可识别');
      const records=[];
      for(const item of skills){
        if(typeof item.path!=='string'||!path.isAbsolute(item.path))continue;
        let realPath=null,sourceHash=null;try{realPath=await fs.realpath(path.join(item.path,'SKILL.md'));sourceHash=await hashSkill(realPath);}catch{}
        const deployments=[];
        for(const key of strings(item.deployed_to)){
          const agent=agents.find(value=>value.key===key);const targetPath=agent?.skills_dir?path.join(agent.skills_dir,path.basename(item.path),'SKILL.md'):null;
          let state='missing';try{if(targetPath)state=(await hashSkill(targetPath))===sourceHash?'matched':'different';}catch{}
          deployments.push({agent:key,title:agent?.display_name||key,path:targetPath,state});
        }
        records.push({id:item.id,name:item.name,path:item.path,realPath,sourceType:item.source_type,tags:strings(item.tags),presets:strings(item.presets),deployedTo:strings(item.deployed_to),deployments});
      }
      const contents={schema:'workflow-manager/1',connected:true,version:stamp,managerRoot,skills:records,presets:presets.map(p=>({id:p.id,name:p.name,skillCount:p.skill_count})),agents:agents.filter(a=>a.installed).map(a=>({key:a.key,title:a.display_name,enabled:a.enabled})),skillCount:records.length};
      const fingerprint=sha(canonical(contents));const capturedAt=nowIso();const directory=path.join(this.root,'manager');await fs.mkdir(directory,{recursive:true});
      const archive=path.join(directory,`manager-${fingerprint}.json`);
      try{await fs.writeFile(archive,JSON.stringify({...contents,fingerprint,capturedAt},null,2),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;const {fingerprint:old,capturedAt:at,...data}=JSON.parse(await fs.readFile(archive));if(old!==fingerprint||sha(canonical(data))!==fingerprint)throw new Error('Skills Manager 旧留档校验失败');}
      this.value={...contents,fingerprint,capturedAt};return this.value;
    }catch(error){this.value={connected:false,issue:error.message,skills:[],capturedAt:nowIso()};return this.value;}
  }
}
function attachManager(catalog,manager,flows=[]){
  const byPath=new Map((manager.skills||[]).filter(s=>s.realPath).map(s=>[normal(s.realPath),s]));
  return {...catalog,manager,skills:catalog.skills.map(item=>({...item,manager:item.realPath?byPath.get(normal(item.realPath))||null:null,workflows:[...new Set([...item.workflows,...flows.filter(f=>f.skillIds.includes(item.id)).map(f=>f.id)])]})),resources:catalog.resources.map(item=>({...item,workflows:[...new Set([...item.workflows,...flows.filter(f=>f.resourceIds.includes(item.id)).map(f=>f.id)])]}))};
}
module.exports={SkillsManager,attachManager};
