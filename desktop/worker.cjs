'use strict';
const {parentPort, workerData} = require('node:worker_threads');
const {activate} = require('./plugin/backend.cjs');
const {validateCall} = require('./contract.cjs');
const {ActiveTasks} = require('./active-tasks.cjs');
const active = new ActiveTasks(workerData.dataDirectory);
let backend, latestView, activeReady = false;
function publishDock(view,force=false) {return active.refresh(view,force).then(value=>{parentPort.postMessage({type:'dock',value});return value;});}
const boot = activate({
  dataDirectory: workerData.dataDirectory,
  publish: value => {latestView=value;parentPort.postMessage({type: 'publish', value});if(activeReady)publishDock(value).catch(error=>parentPort.postMessage({type:'log',message:error.message}));},
  log: message => parentPort.postMessage({type: 'log', message: String(message)})
}).then(async value => {
  backend = value;
  await active.init();activeReady=true;await publishDock(latestView);
  parentPort.postMessage({type: 'ready'});
}).catch(error => {
  parentPort.postMessage({type: 'fatal', error: error.message});
  throw error;
});
// Keep initialization errors observable without an unhandled-rejection crash.
boot.catch(() => {});
parentPort.on('message', async message => {
  if (message.type === 'dispose') {
    try { await boot; await backend.dispose(); await active.dispose(); parentPort.postMessage({type: 'closed'}); parentPort.close(); }
    catch (error) { parentPort.postMessage({type: 'close-error', error: error.message}); }
    return;
  }
  if (message.type !== 'call') return;
  try {
    const {method, args} = validateCall(message);
    await boot;
    let value;
    if(method==='dockRefresh')value=await publishDock(await backend.call('refresh'),true);
    else if(method.startsWith('dock'))value=await active.call(method,args);
    else value=await backend.call(method,args);
    parentPort.postMessage({type: 'result', id: message.id, value});
  } catch (error) { parentPort.postMessage({type: 'result', id: message.id, error: error.message}); }
});
