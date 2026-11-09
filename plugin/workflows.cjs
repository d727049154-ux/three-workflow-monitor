'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {inside,nowIso} = require('./core.cjs');
const {publicText} = require('./tasks.cjs');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const normalized=value=>path.resolve(value).toLocaleLowerCase();
async function validateWorkflow(input,catalog,existing=[]) {
  const title=String(input.title||'').trim();if(!title||title.length>60||/[\x00-\x1f]/.test(title))throw new Error('请填写 1–60 字的流程名称');
  if(existing.some(flow=>flow.title===title&&flow.id!==input.id))throw new Error('已经有同名工作流，请使用便于区分的名称');
  let root=String(input.root||'').trim();
  if(root){if(!path.isAbsolute(root)||root.length>512||/[\x00-\x1f]/.test(root))throw new Error('请填写现有工程的绝对目录');if(!(await fs.stat(root)).isDirectory())throw new Error('工程路径不是目录');root=path.resolve(root);}
  const labels=Array.isArray(input.stages)?input.stages:[];
  if(!labels.length||labels.length>10||labels.some(x=>typeof x!=='string'||!x.trim()||x.length>30||/[\x00-\x1f]/.test(x)))throw new Error('请填写 1–10 个流程环节，每项不超过 30 字');
  const threadIds=[...new Set(input.threadIds||[])];if(threadIds.length>40||threadIds.some(id=>!uuid.test(id)))throw new Error('聊天 ID 应为完整 UUID，最多 40 条');
  const select=(ids,records,label)=>{if(!Array.isArray(ids)||ids.length>40)throw new Error(`${label}关联过多`);const known=new Set(records.map(item=>item.id));if(ids.some(id=>!known.has(id)))throw new Error(`${label}目录已变化，请刷新后重选`);return [...new Set(ids)];};
  const previous=existing.find(flow=>flow.id===input.id);
  if(input.id&&!previous)throw new Error('要修改的工作流不存在');
  if(!previous&&existing.length>=40)throw new Error('当前最多保留 40 条自定义工作流');
  return {id:previous?.id||`flow-${randomUUID()}`,title,root,stages:labels.map((label,index)=>({id:`step-${index+1}`,label:label.trim()})),threadIds,autoDiscover:Boolean(input.autoDiscover&&root),skillIds:select(input.skillIds||[],catalog.skills,'技能'),resourceIds:select(input.resourceIds||[],catalog.resources,'资源'),createdAt:previous?.createdAt||nowIso(),updatedAt:nowIso(),paused:previous?.paused||false};
}
class SessionDirectory {
  constructor(){this.names=new Map();this.heads=new Map();this.lastScan=0;this.root=null;this.index=[];}
  async scan(sessionRoot,force=false) {
    if(!sessionRoot)return;
    if(this.root===sessionRoot&&!force&&Date.now()-this.lastScan<60000)return;
    if(this.root!==sessionRoot){this.heads.clear();this.names.clear();}
    const realRoot=await fs.realpath(sessionRoot);const names=new Map();let count=0;
    const walk=async(dir,depth)=>{for(const item of await fs.readdir(dir,{withFileTypes:true})){
      if(++count>25000)throw new Error('聊天目录超过扫描上限，请使用更小的会话目录');
      if(item.isDirectory()&&depth<3&&/^\d{2,4}$/.test(item.name))await walk(path.join(dir,item.name),depth+1);
      else if(item.isFile()&&depth===3){const match=item.name.match(/-([a-f0-9-]{36})\.jsonl$/);if(match&&uuid.test(match[1]))names.set(match[1],path.relative(sessionRoot,path.join(dir,item.name)));}
    }};
    await walk(sessionRoot,0);
    const indexPath=path.join(path.dirname(sessionRoot),'session_index.jsonl');let entries=[];
    try{const handle=await fs.open(indexPath,'r');try{const stat=await handle.stat();const start=Math.max(0,stat.size-2*1024*1024);const buf=Buffer.alloc(Math.min(stat.size,2*1024*1024));const read=await handle.read(buf,0,buf.length,start);let data=buf.subarray(0,read.bytesRead).toString('utf8');if(start)data=data.slice(data.indexOf('\n')+1);const map=new Map();for(const line of data.split('\n'))try{const item=JSON.parse(line);if(uuid.test(item.id)&&typeof item.thread_name==='string')map.set(item.id,item);}catch{}entries=[...map.values()].sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))).slice(0,200);}finally{await handle.close();}}catch(error){if(error.code!=='ENOENT')throw error;}
    this.names=names;this.index=entries;this.root=sessionRoot;this.realRoot=realRoot;this.lastScan=Date.now();
  }
  async header(id) {
    const relative=this.names.get(id);if(!relative)return null;
    if(this.heads.has(relative))return this.heads.get(relative);
    const file=path.resolve(this.root,relative);if(!inside(this.realRoot,await fs.realpath(file)))throw new Error('聊天文件链接超出会话目录');
    const handle=await fs.open(file,'r');let metadata;
    try{const bytes=Buffer.alloc(256*1024);const read=await handle.read(bytes,0,bytes.length,0);const end=bytes.subarray(0,read.bytesRead).indexOf(10);if(end<0)return null;metadata=JSON.parse(bytes.subarray(0,end).toString('utf8'));}finally{await handle.close();}
    const p=metadata.payload;if(metadata.type!=='session_meta'||p?.id!==id||!path.isAbsolute(p?.cwd||''))return null;
    // Only user-facing chats are auto-associated; agent/guardian sessions remain separate.
    if(p.source&&typeof p.source==='object'&&p.source.subagent || p.agent_role)return null;
    const value={id,projectRoot:p.cwd,sessionFile:relative};this.heads.set(relative,value);return value;
  }
  async links(flows,sessionRoot) {
    const active=flows.filter(f=>!f.paused&&(f.autoDiscover||f.threadIds.length));
    if(!active.length)return {links:[],issues:[]};
    await this.scan(sessionRoot);const links=[],issues=[];const titles=new Map(this.index.map(item=>[item.id,item.thread_name]));
    for(const flow of active){
      const chosen=new Map();
      for(const id of flow.threadIds){const found=await this.header(id);if(found)chosen.set(id,found);else issues.push({flow:flow.id,message:`关联聊天 ${id} 暂不可读`});}
      if(flow.autoDiscover)for(const item of this.index){const found=await this.header(item.id);if(found&&normalized(found.projectRoot)===normalized(flow.root))chosen.set(item.id,found);}
      for(const found of [...chosen.values()].slice(0,40))links.push({...found,id:`${flow.id}:${found.id}`,threadId:found.id,title:publicText(titles.get(found.id)||`聊天 ${found.id}`).slice(0,160),workflow:flow.id,focus:'按工程或指定 ID 关联；公开进展持续更新，具体环节尚未分配。',stages:[],reports:[],linkedAt:flow.createdAt});
      if(chosen.size>40)issues.push({flow:flow.id,message:'关联任务超过 40 条，仅显示最近范围；可改为指定聊天 ID。'});
    }
    return {links,issues};
  }
}
function integrationPrompt(flow) {
  const file=flow.root?path.join(flow.root,'workflow-progress.json'):'[工程目录]\\workflow-progress.json';
  const example={schema:'workflow-progress/1',updatedAt:'[实际 ISO 时间，带时区]',state:'running',stage:flow.stages[0].label,summary:'[真实进展]',tasks:[{id:'task-1',title:'[小任务名称]',stage:flow.stages[0].id,state:'running',detail:'[本次完成、未完成与依据]',updatedAt:'[实际 ISO 时间，带时区]'}],acceptance:{visual:false,user:false}};
  return `继续「${flow.title}」工作流。沿用当前工程与授权，每个重要阶段把真实进展写入 ${file}，采用下列格式，先写同目录临时文件再原子替换。ID 保持稳定，未知总数不填百分比，技术完成、视觉验收和用户确认分别记录。不要为了上报而修改原素材。\n${JSON.stringify(example,null,2)}\n环节：${flow.stages.map(stage=>`${stage.id} = ${stage.label}`).join('；')}`;
}
module.exports={SessionDirectory,validateWorkflow,integrationPrompt};
