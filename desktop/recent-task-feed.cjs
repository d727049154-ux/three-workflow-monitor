'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const STATUS={task_started:'inProgress',task_complete:'completed',turn_aborted:'interrupted',task_failed:'failed',error:'failed'};
// Read older public messages without retaining image records, tool arguments or reasoning.
// Giant single-line records are skipped rather than accumulated in memory.
async function publicContext(file,publicText,{maxBytes=64*1024*1024,maxMessages=8}={}){
  const handle=await fs.open(file,'r'),messages=[];let session=null,bytesRead=0;
  try{
    const size=(await handle.stat()).size,min=Math.max(0,size-maxBytes);
    let position=size,carry=Buffer.alloc(0),skipLong=false,first=true;
    function consume(line){
      if(!line.length||line.length>512*1024)return;
      try{
        const record=JSON.parse(line.toString('utf8')),payload=record.payload||{};
        if(!Number.isFinite(Date.parse(record.timestamp)))return;
        const at=new Date(record.timestamp).toISOString();
        if(Date.parse(at)>Date.now()+300000)return;
        if(!session&&record.type==='event_msg'&&STATUS[payload.type])session={turnId:payload.turn_id||null,status:STATUS[payload.type],statusAt:at};
        if(messages.length<maxMessages&&record.type==='response_item'&&payload.type==='message'&&payload.role==='assistant'&&['commentary','final','final_answer'].includes(payload.phase)){
          const text=publicText((payload.content||[]).filter(item=>item.type==='output_text').map(item=>item.text).join('\n'));
          if(text&&!messages.some(message=>message.text===text))messages.push({id:payload.id||at,phase:payload.phase,text,at});
        }
      }catch{/* Incomplete records are retried by the incremental reader. */}
    }
    while(position>min){
      const start=Math.max(min,position-1024*1024),chunk=Buffer.alloc(position-start);
      const read=await handle.read(chunk,0,chunk.length,start);bytesRead+=read.bytesRead;position=start;
      let bytes=Buffer.concat([chunk.subarray(0,read.bytesRead),carry]),end=bytes.length;
      if(first||skipLong){end=bytes.lastIndexOf(10);first=false;skipLong=false;if(end<0){carry=Buffer.alloc(0);skipLong=true;continue;}}
      while(end>0){
        const newline=bytes.lastIndexOf(10,end-1);
        if(newline<0)break;
        consume(bytes.subarray(newline+1,end));end=newline;
        if(messages.length>=maxMessages&&session)break;
      }
      if(messages.length>=maxMessages&&session)break;
      carry=bytes.subarray(0,end);
      if(carry.length>512*1024){carry=Buffer.alloc(0);skipLong=true;}
      if(position===0&&!skipLong)consume(carry);
    }
    return {messages:messages.reverse(),session,bytesRead};
  }finally{await handle.close();}
}
class RecentTaskFeed{
  constructor(engineRoot){
    const {TaskFeed,publicText}=require(path.join(engineRoot,'tasks.cjs'));
    this.feed=new TaskFeed();this.publicText=publicText;this.context=new Map();
  }
  restore(tasks){this.feed.restore(tasks);}
  async read(link,sessionRoot){
    const data=await this.feed.read(link,sessionRoot);
    if(!this.context.has(link.id)){
      const needsContext=data.messages.length<8||data.session.status==='unknown';
      this.context.set(link.id,needsContext?await publicContext(data.file,this.publicText):{messages:[],session:null});
    }
    const context=this.context.get(link.id);
    const messages=[...new Map([...context.messages,...data.messages].map(message=>[message.id||message.text,message])).values()].sort((a,b)=>(a.at||'').localeCompare(b.at||'')).slice(-8);
    const session=context.session&&(!data.session.statusAt||context.session.statusAt>data.session.statusAt)?context.session:data.session;
    return {...data,messages,session,updatedAt:messages.at(-1)?.at||data.updatedAt};
  }
}
module.exports={RecentTaskFeed,publicContext};
