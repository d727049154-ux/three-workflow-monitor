'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {activate} = require('../plugin/backend.cjs');
(async () => {
  const dataDirectory = path.resolve(__dirname, '../qa/live-sample');
  const backend = await activate({dataDirectory});
  try {
    const current = await backend.call('current');
    if (current.error) throw new Error(current.error);
    const checkpoint = await backend.call('checkpoint');
    const integrity = await backend.call('verify');
    const exported = await backend.call('export');
    const result = {observedAt: new Date().toISOString(), snapshot: current.snapshot, checkpoint: checkpoint.snapshot.id, integrity, exported};
    await fs.writeFile(path.resolve(__dirname, '../qa/live-sample-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({projects: current.snapshot.projects.map(({title, stateLabel, phase, sources}) => ({title, stateLabel, phase, sources: sources.length})), checkpoint: result.checkpoint, integrity, exported}, null, 2));
  } finally {await backend.dispose();}
})().catch(error => {console.error(error); process.exitCode = 1;});
