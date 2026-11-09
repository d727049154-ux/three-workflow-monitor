'use strict';
class Activity {
  constructor(history) {this.history=history;this.cache=new Map();}
  async events(id) {
    if(this.cache.has(id))return this.cache.get(id);
    const record=await this.history.read(id);
    const events=(record.changes||[]).map((change,index)=>{
      const project=record.projects.find(p=>p.id===change.workflow || p.tasks?.some(t=>t.id===change.taskId));
      const task=project?.tasks?.find(t=>t.id===change.taskId);
      return {...change,key:`${id}:${index}`,snapshotId:id,snapshotHash:record.hash,observedAt:record.observedAt,sourceAt:task?.priorityAt||task?.updatedAt||project?.updatedAt||null,workflow:change.workflow||project?.id||'',workflowTitle:project?.title||'原工作流',summary:change.summary||task?.latestText||'状态记录有更新'};
    });
    this.cache.set(id,events);return events;
  }
  async page(before) {
    if(before!=null && (!Number.isSafeInteger(before)||before<1))throw new Error('变化页码无效');
    const ids=this.history.ids.filter(id=>before==null||id<before).slice(-30).reverse();
    const events=[];for(const id of ids)events.push(...await this.events(id));
    return {schema:'workflow-activity/1',head:this.history.last?{id:this.history.last.id,hash:this.history.last.hash}:null,events,scannedSnapshots:ids.length,nextBefore:ids.at(-1)>1?ids.at(-1):null};
  }
}
module.exports={Activity};
