'use strict';
// Isolated UI verification data. Does not create or message real Codex chats.
const fs=require('node:fs/promises');const path=require('node:path');const {randomUUID}=require('node:crypto');
const base=path.resolve(__dirname,'../qa/scenarios/dynamic-workflow');const project=path.join(base,'project');const codex=path.join(base,'codex');const day=path.join(codex,'sessions','2026','11','06');const manifest=path.join(base,'scenario.json');
const event=(type,payload)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n';
const report=advanced=>({schema:'workflow-progress/1',updatedAt:new Date().toISOString(),state:advanced?'complete':'running',stage:'制作',summary:advanced?'验证进展 B：两镜候选已生成，视觉验收未完成':'验证进展 A：正在制作第一镜',progress:{completed:advanced?2:0,total:2,unit:'镜',label:'验证任务'},tasks:[{id:'shot-1',title:'验证镜头一',stage:'step-2',state:advanced?'complete':'running',detail:advanced?'验证进展 B：候选已保存；视觉与用户验收尚未登记':'验证进展 A：等待下一次源记录更新',updatedAt:new Date().toISOString()}],acceptance:{visual:false,user:false}});
async function chat(id,title,text){const file=path.join(day,`rollout-2026-11-06T12-00-00-${id}.jsonl`);await fs.writeFile(file,event('session_meta',{id,cwd:project,source:'cli'})+event('event_msg',{type:'task_started',turn_id:'verification-turn'})+event('response_item',{id:`msg-${id}`,type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text}]}),{flag:'wx'});await fs.appendFile(path.join(codex,'session_index.jsonl'),JSON.stringify({id,thread_name:title,updated_at:new Date().toISOString()})+'\n');return file;}
(async()=>{
  if(process.argv[2]==='prepare'){
    await fs.mkdir(project,{recursive:true});await fs.mkdir(day,{recursive:true});const id=randomUUID();const firstFile=await chat(id,'验证聊天一','验证聊天 A：独立测试记录，等待后续更新。');
    await fs.writeFile(path.join(project,'workflow-progress.json'),JSON.stringify(report(false),null,2),{flag:'wx'});
    const config={revision:1,values:{...require('../plugin/defaults.json'),taskLinksFile:'',codexSessionsRoot:path.join(codex,'sessions')}};await fs.writeFile(path.resolve(__dirname,'../qa/profiles/optimization-ui/config.json'),JSON.stringify(config,null,2),{flag:'wx'});
    await fs.writeFile(manifest,JSON.stringify({project,firstId:id,firstFile,preparedAt:new Date().toISOString()},null,2),{flag:'wx'});console.log(JSON.stringify({project,phase:'A',profile:'optimization-ui'}));
  }else if(process.argv[2]==='advance'){
    const state=JSON.parse(await fs.readFile(manifest));const file=path.join(project,'workflow-progress.json');const temp=`${file}.pending`;await fs.writeFile(temp,JSON.stringify(report(true),null,2));await fs.rename(temp,file);
    await fs.appendFile(state.firstFile,event('response_item',{id:'verification-update-b',type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'验证聊天 B：源记录已经更新，弹窗应自动显示这条进展。'}]}));
    const nextId=randomUUID();await chat(nextId,'后续新增验证聊天','验证新增聊天：在流程创建以后才出现，应该被自动关联。');const advancedAt=new Date().toISOString();await fs.writeFile(manifest,JSON.stringify({...state,secondId:nextId,advancedAt},null,2));console.log(JSON.stringify({project,phase:'B',advancedAt,newChatId:nextId}));
  }else throw new Error('Use prepare or advance');
})().catch(error=>{console.error(error.message);process.exitCode=1});
