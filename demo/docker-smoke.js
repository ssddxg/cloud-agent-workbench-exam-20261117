// End-to-end application validation, not an auxiliary coding agent.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.DEMO_URL || 'http://127.0.0.1:3210';
async function api(route, method='GET', body) {
  const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const value=await r.json(); assert.ok(r.ok,`${route}: ${r.status}`); return value;
}
async function wait(id) {
  for(let i=0;i<180;i++) {
    const s=await api(`/api/sessions/${id}`);
    if(!['queued','running','cancelling'].includes(s.status)){assert.equal(s.status,'completed',s.error);return s;}
    await new Promise(r=>setTimeout(r,1500));
  }
  throw new Error('Real CLI timed out');
}
const health=await api('/api/health'); assert.ok(health.cliAvailable&&health.configured);
const session=await api('/api/sessions','POST',{title:'Docker real CLI verification'});
await api(`/api/sessions/${session.id}/files`,'POST',{name:'sample.csv',contentBase64:Buffer.from('category,amount\ntravel,32.5\ntravel,17.5\nfood,12\n').toString('base64')});
await api(`/api/sessions/${session.id}/messages`,'POST',{content:'Use actual tools to read uploads/sample.csv. Create a zero-dependency Node.js script outputs/summarize.mjs that calculates the sum of amount by category and total. Run it, save JSON to outputs/result.json, and verify travel=50 and total=62. Do not install anything. Reply briefly in Chinese.'});
const initial=await wait(session.id);
await api(`/api/sessions/${session.id}/messages`,'POST',{content:'Continue: create outputs/report.md summarizing the actual CSV totals in Chinese. Read result.json to verify the numbers; do not invent data.'});
const final=await wait(session.id);
assert.equal(final.threadId,initial.threadId,'Follow-up must resume the same real CLI thread');
assert.equal(final.runs.length,2);
const files=await api(`/api/sessions/${session.id}/files`);
assert.ok(files.some(f=>f.path==='outputs/report.md'));
const events=await api(`/api/sessions/${session.id}/events`);
assert.ok(events.some(e=>e.event?.item?.type==='command_execution'&&e.event.item.exit_code===0));
const artifacts={};
for(const file of files.filter(f=>f.path.startsWith('outputs/'))){artifacts[file.path]=await api(`/api/sessions/${session.id}/file?path=${encodeURIComponent(file.path)}`);}
const evidence={generatedAt:new Date().toISOString(),environment:'GitHub Actions Ubuntu runner; application and real Codex CLI inside built Docker image',health,checks:{dockerBuiltAndStarted:true,realCliCommands:true,upload:true,artifactPreview:true,followupResumedSameThread:true},session:final,events,files,artifacts};
await fs.mkdir('evidence',{recursive:true});
await fs.writeFile('evidence/docker-smoke.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify({status:'passed',threadId:final.threadId,runs:final.runs.length,files:files.map(f=>f.path)},null,2));
