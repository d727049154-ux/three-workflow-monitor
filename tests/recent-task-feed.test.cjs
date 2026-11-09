'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {RecentTaskFeed}=require('../desktop/recent-task-feed.cjs');
test('large image/tool records do not hide the latest public update or turn state',async()=>{
  const root=path.join(__dirname,'..','qa','tests','large-chat-'+Date.now()),id=randomUUID(),file=path.join(root,id+'.jsonl');
  await fs.mkdir(root,{recursive:true});
  const at=new Date(Date.now()-2000).toISOString();
  const rows=[
    {timestamp:at,type:'session_meta',payload:{id,cwd:root}},
    {timestamp:at,type:'event_msg',payload:{type:'task_started',turn_id:'large-turn'}},
    {timestamp:at,type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',id:'public-step',content:[{type:'output_text',text:'第 2 项正在核对，等待画面输出。'}]}},
    {timestamp:at,type:'response_item',payload:{type:'function_call',arguments:'sensitive-tool-payload-'+'x'.repeat(4*1024*1024)}}
  ];
  await fs.writeFile(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const feed=new RecentTaskFeed(path.join(__dirname,'..','plugin')),link={id,threadId:id,projectRoot:root,sessionFile:id+'.jsonl'};
  const first=await feed.read(link,root);assert.equal(first.session.status,'inProgress');assert.equal(first.messages.length,1);assert.match(first.messages[0].text,/第 2 项/);
  assert.equal(JSON.stringify(first.messages).includes('sensitive-tool-payload'),false);
  await fs.appendFile(file,JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'task_complete',turn_id:'large-turn'}})+'\n');
  assert.equal((await feed.read(link,root)).session.status,'completed');
});
