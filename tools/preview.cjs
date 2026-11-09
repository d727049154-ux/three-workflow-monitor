'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {activate} = require('../plugin/backend.cjs');
const {root, dataDirectory, registryPath, schema, publicRecord, acquireLock, releaseLock} = require('./preview-state.cjs');
(async () => {
  const owner = await acquireLock();
  let backend;
  try { backend = await activate({dataDirectory}); }
  catch (error) { await releaseLock(owner); throw error; }
  const csrf = crypto.randomBytes(24).toString('hex');
  const controlToken = crypto.randomBytes(24).toString('hex');
  let record, stopping = false;
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>工作流观察 · 本机预览</title><link rel="stylesheet" href="/plugin/panel.css"><style>html{background:#212728;color:#d3e0d7;font-family:'Segoe UI','Microsoft YaHei UI',sans-serif}body{margin:0;padding:24px 14px 50px}.preview-caption{max-width:420px;margin:0 auto 10px;font-size:11px;line-height:1.8;color:#aabcaf}.preview-caption strong{color:#d4c393;font-weight:500}#app{max-width:420px;margin:auto;border:1px solid #68766c;border-radius:15px;overflow:hidden;box-shadow:0 15px 50px #0005}button,input{font:inherit}@media(max-width:500px){body{padding:10px 8px}#app{max-width:100%}}</style><div class="preview-caption"><strong>本机可交互预览 · 尚未安装到 Token Monitor</strong><br>读取真实流程记录；预览历史独立保存。关闭页面即可离开预览。</div><main id="app"></main><script type="module">import {activate} from '/plugin/ui.mjs';let listeners=new Set();async function call(method,args){const r=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json','X-Workflow-Preview':'${csrf}'},body:JSON.stringify({method,args})});const v=await r.json();if(!r.ok)throw new Error(v.error);if(v.schema==='workflow-view/1')for(const fn of listeners)fn(v);return v;}const instance=activate({backend:{call,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}}});const view=await instance.mount(document.getElementById('app'),{surface:'page'});const timer=setInterval(()=>call('current').catch(()=>{}),15000);addEventListener('pagehide',()=>{clearInterval(timer);view.dispose();},{once:true});</script></html>`;
  const allowed = new Set(['current','refresh','refreshAll','checkpoint','history','snapshot','verify','export','configure','openData','openProject','openSource','openThread','openTaskProject','catalog','catalogRefresh','catalogExport','catalogOpen','workspaceState','quickFavorite','quickVisit','activity','activitySeen','workflowSave','workflowPause','workflowPrompt','managerOpen','resourceSave','resourcePause','workspaceExport']);
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (status, value) => {res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});res.end(JSON.stringify(value));};
    try {
      if (req.headers.host !== `127.0.0.1:${server.address().port}` || (req.headers.origin && req.headers.origin !== origin)) return send(403, {error:'Origin is not allowed'});
      if (req.method === 'POST' && req.url === '/preview-control') {
        if (req.headers['x-workflow-control'] !== controlToken || !record) return send(403,{error:'Control identity required'});
        let input='';for await(const chunk of req){input+=chunk;if(input.length>1024)throw new Error('Request too large');}
        const command=JSON.parse(input);
        if(command.instanceId!==record.instanceId)return send(403,{error:'Instance mismatch'});
        if(!['status','stop'].includes(command.action))return send(400,{error:'Unknown control action'});
        res.setHeader('Connection','close');send(200,{...publicRecord(record),stopping:command.action==='stop'});
        if(command.action==='stop')setImmediate(()=>stop().catch(error=>{console.error(error.message);process.exitCode=1;}));
        return;
      }
      if (req.method === 'GET' && req.url === '/') {res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(html);return;}
      if (req.method === 'GET' && ['/plugin/ui.mjs','/plugin/catalog-ui.mjs','/plugin/quick-ui.mjs','/plugin/activity-ui.mjs','/plugin/workflows-ui.mjs','/plugin/resources-ui.mjs','/plugin/clipboard.mjs','/plugin/targets.mjs','/plugin/search.mjs','/plugin/fuse.basic-7.5.0.min.mjs','/plugin/panel.css'].includes(req.url)) {res.writeHead(200, {'content-type':req.url.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(await fs.readFile(path.join(root,req.url.slice(1))));return;}
      if (req.method !== 'POST' || req.url !== '/api' || req.headers['x-workflow-preview'] !== csrf) return send(404,{error:'Not found'});
      let body=''; for await(const chunk of req){body+=chunk;if(body.length>16384)throw new Error('Request too large');}
      const {method,args}=JSON.parse(body);if(!allowed.has(method))return send(400,{error:'Unknown method'});
      send(200,await backend.call(method,args));
    } catch(error){send(400,{error:error.message});}
  });
  server.on('error', async error => {console.error(error.message);await backend.dispose();await releaseLock(owner);process.exitCode=1;});
  const portArg=process.argv.indexOf('--port');const requestedPort=portArg<0?0:Number(process.argv[portArg+1]);
  if(!Number.isInteger(requestedPort)||requestedPort<0||requestedPort>65535)throw new Error('预览端口无效');
  server.listen(requestedPort,'127.0.0.1',async()=>{
    record={schema,root,instanceId:owner.instanceId,pid:process.pid,url:`http://127.0.0.1:${server.address().port}`,dataDirectory,startedAt:new Date().toISOString(),controlToken};
    await fs.writeFile(registryPath,JSON.stringify(record,null,2));console.log(JSON.stringify(publicRecord(record)));
  });
  async function stop(){
    if(stopping)return;stopping=true;
    await backend.dispose();
    await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});
    await releaseLock(owner);
    if(record)await fs.writeFile(registryPath,JSON.stringify({...record,stoppedAt:new Date().toISOString()},null,2));
    process.exit(0);
  }
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
})().catch(error=>{console.error(error);process.exitCode=1;});
