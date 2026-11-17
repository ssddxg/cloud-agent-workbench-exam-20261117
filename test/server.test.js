// Deterministic API/lifecycle tests use a fake CLI process. They are not evidence
// that the real model or Codex CLI has run; that evidence lives separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fakeCliSource = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const emit = event => console.log(JSON.stringify(event));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  emit({type:'thread.started', thread_id:'00000000-0000-4000-8000-000000000001'});
  emit({type:'turn.started'});
  if (input.includes('sleep')) { setInterval(() => {}, 1000); return; }
  if (input.includes('bridge-fail')) {
    const raw = args.find(arg => arg.startsWith('model_providers.workbench.base_url='));
    const url = JSON.parse(raw.slice(raw.indexOf('=') + 1));
    const response = await fetch(url + '/responses', {method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer ' + process.env.WORKBENCH_BRIDGE_KEY}, body: JSON.stringify({input:'test', model:'test-model'})});
    const body = await response.json();
    emit({type:'error', message:body.error.message});
    emit({type:'turn.failed', error:body.error});
    process.exitCode = 1;
    return;
  }
  if (input.includes('secret-error')) {
    emit({type:'error', message:'Failure token=' + process.env.WORKBENCH_BRIDGE_KEY});
    process.stderr.write('private=' + process.env.WORKBENCH_BRIDGE_KEY);
    process.exitCode = 1;
    return;
  }
  if (input.includes('inherited-stdout')) {
    // Windows shells may leave descendants holding the CLI's pipe handles.
    // The CLI has exited; its 'close' event can still wait for those handles.
    const descendant = require('node:child_process').spawn(process.execPath, ['-e','setTimeout(() => {}, 3000)'], {stdio:['ignore','inherit','inherit'], detached:true, windowsHide:true});
    descendant.unref();
  }
  fs.mkdirSync('outputs', {recursive:true});
  const resumed = args.includes('resume');
  fs.writeFileSync(path.join('outputs', 'result.txt'), input);
  emit({type:'item.completed', item:{type:'command_execution', command:'write outputs/result.txt', aggregated_output:'saved', exit_code:0, status:'completed'}});
  emit({type:'item.completed', item:{type:'agent_message', text:resumed ? 'resumed: ' + input : 'done: ' + input}});
  emit({type:'turn.completed', usage:{input_tokens:5, output_tokens:3}});
});
`;

async function freePort() {
  const listener = http.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function makeHarness() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-api-test-'));
  const fake = path.join(temp, 'fake-codex.cjs.js');
  fs.writeFileSync(fake, fakeCliSource);
  const port = await freePort();
  const upstream = http.createServer((req, res) => {
    res.writeHead(401, {'Content-Type':'application/json'});
    res.end(JSON.stringify({error:{message:'DO-NOT-EXPOSE test-upstream-key'}}));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const base = `http://127.0.0.1:${port}`;
  let child;
  let logs = '';
  const request = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + route, {method, headers:{...(body === undefined ? {} : {'Content-Type':'application/json'}), ...headers}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { value = text; }
    return {status:response.status, value, headers:response.headers};
  };
  const waitFor = async (id, statuses, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const {value} = await request('/api/sessions/' + id);
      if (statuses.includes(value.status)) return value;
      await sleep(30);
    }
    throw new Error(`Timed out waiting for ${id}: ${logs}`);
  };
  const start = async () => {
    // IPC emits the same signal callback on Windows, where process.kill(SIGTERM)
    // otherwise terminates Node without executing JavaScript signal handlers.
    const boot = `process.on('message', m => { if (m === 'shutdown') process.emit('SIGTERM'); }); await import(${JSON.stringify(pathToFileURL(path.join(project,'src/server.js')).href)});`;
    child = spawn(process.execPath, ['--input-type=module','-e',boot], {cwd:project, windowsHide:true, stdio:['ignore','pipe','pipe','ipc'], env:{...process.env, PORT:String(port), HOST:'127.0.0.1', DATA_DIR:path.join(temp,'data'), CODEX_BIN:fake, AGENT_API_KEY:'test-upstream-key', AGENT_BASE_URL:`http://127.0.0.1:${upstream.address().port}/v1`, AGENT_MODEL:'test-model', AGENT_PROTOCOL:'chat', MAX_CONCURRENT_RUNS:'1', RUN_TIMEOUT_MS:'20000'}});
    child.stdout.on('data', chunk => logs += chunk);
    child.stderr.on('data', chunk => logs += chunk);
    for (let i = 0; i < 150; i++) {
      try { const result = await request('/api/health'); if (result.status === 200) return; } catch {}
      if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      await sleep(30);
    }
    throw new Error(`Server did not become healthy: ${logs}`);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    try {
      const {value:sessions} = await request('/api/sessions');
      for (const session of sessions) if (['queued','running','cancelling'].includes(session.status)) {
        await request(`/api/sessions/${session.id}/cancel`, 'POST', {});
        await waitFor(session.id, ['cancelled','completed','failed']);
      }
    } catch {}
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  await start();
  const shutdown = async () => {
    const exited = once(child,'exit');
    child.send('shutdown');
    await Promise.race([exited,sleep(6000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); throw new Error('Graceful shutdown did not exit'); }
  };
  return {base, temp, request, waitFor, start, stop, shutdown, get logs(){return logs;}, async close(){await stop(); upstream.closeAllConnections(); await new Promise(resolve=>upstream.close(resolve)); fs.rmSync(temp,{recursive:true,force:true});}};
}

test('HTTP API files, lifecycle, replay, persistence and provider failures (mock CLI)', {timeout:60000}, async t => {
  const app = await makeHarness();
  t.after(() => app.close());
  const create = async title => (await app.request('/api/sessions','POST',{title})).value;
  let first;
  await t.test('create, rename, upload, preview, download and export', async () => {
    const health = await app.request('/api/health');
    assert.equal(health.value.configured,true);
    assert.equal(health.value.cliAvailable,true);
    assert.equal(JSON.stringify(health.value).includes('test-upstream-key'),false);
    first = await create('日常工作');
    assert.equal(first.status,'idle');
    assert.equal((await app.request('/api/sessions/'+first.id,'PATCH',{title:'修改后名称'})).value.title,'修改后名称');
    const upload = {name:'材料.csv',contentBase64:Buffer.from('category,amount\nfood,12\n').toString('base64')};
    assert.equal((await app.request(`/api/sessions/${first.id}/files`,'POST',upload)).status,201);
    assert.equal((await app.request(`/api/sessions/${first.id}/files`,'POST',upload)).status,409);
    const files = (await app.request(`/api/sessions/${first.id}/files`)).value;
    assert.equal(files[0].path,'uploads/材料.csv');
    const fileRoute = `/api/sessions/${first.id}/file?path=${encodeURIComponent(files[0].path)}`;
    assert.equal((await app.request(fileRoute)).value.content,'category,amount\nfood,12\n');
    const download = await app.request(fileRoute+'&download=1');
    assert.equal(download.value,'category,amount\nfood,12\n');
    assert.match(download.headers.get('content-disposition'),/attachment/);
    const exported = await app.request(`/api/sessions/${first.id}/export`);
    assert.equal(exported.value.session.title,'修改后名称');
    assert.equal(exported.value.files.length,1);
  });
  await t.test('reject invalid messages, traversal, dot files, cross-site calls and bridge access', async () => {
    const route = `/api/sessions/${first.id}`;
    assert.equal((await app.request(route+'/messages','POST',{content:' '})).status,400);
    assert.equal((await app.request(route+'/messages','POST',{content:'x'.repeat(32001)})).status,400);
    for (const invalid of ['../session.json','..\\session.json','.env','uploads/../../session.json','C:/Windows/win.ini']) {
      assert.equal((await app.request(route+'/file?path='+encodeURIComponent(invalid))).status,400,invalid);
    }
    assert.equal((await app.request(route+'/files','POST',{name:'../escape',contentBase64:'eA=='})).status,400);
    assert.equal((await app.request('/api/sessions','POST',{title:'x'},{Origin:'https://attacker.example'})).status,403);
    assert.equal((await app.request('/internal/v1/responses','POST',{input:'x'})).status,403);
    assert.equal((await app.request('/api/sessions/not-an-id')).status,404);
  });
  await t.test('reject dangling symlink or junction parents rather than following them', async t => {
    const link = path.join(app.temp,'data','sessions',first.id,'workspace','uploads','dangling');
    try { fs.symlinkSync(path.join(app.temp,'does-not-exist'),link,process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM','EACCES','ENOTSUP'].includes(error.code)) return t.skip('Symlink creation unavailable'); throw error; }
    assert.equal((await app.request(`/api/sessions/${first.id}/file?path=uploads%2Fdangling%2Fsecret.txt`)).status,403);
    assert.ok(!(await app.request(`/api/sessions/${first.id}/files`)).value.some(file=>file.path.includes('dangling')));
  });
  await t.test('CLI subprocess result, conversation resume and separate workspace files', async () => {
    assert.equal((await app.request(`/api/sessions/${first.id}/messages`,'POST',{content:'first job'})).status,202);
    const done = await app.waitFor(first.id,['completed','failed']);
    assert.equal(done.status,'completed',done.error);
    assert.equal(done.messages.at(-1).content,'done: first job');
    assert.equal(done.runs[0].usage.input_tokens,5);
    assert.equal((await app.request(`/api/sessions/${first.id}/messages`,'POST',{content:'follow up'})).status,202);
    const resumed = await app.waitFor(first.id,['completed','failed']);
    assert.equal(resumed.messages.at(-1).content,'resumed: follow up');
    const second = await create('第二会话');
    const files = await app.request(`/api/sessions/${second.id}/files`);
    assert.deepEqual(files.value,[]);
  });
  await t.test('durable event replay and Last-Event-ID reconnect', async () => {
    const events = (await app.request(`/api/sessions/${first.id}/events`)).value;
    assert.ok(events.some(e=>e.type==='message'));
    assert.ok(events.some(e=>e.type==='agent' && e.event.type==='item.completed'));
    const cursor = events.at(-2).id;
    const controller = new AbortController();
    const stream = await fetch(`${app.base}/api/sessions/${first.id}/stream`,{headers:{'Last-Event-ID':cursor},signal:controller.signal});
    assert.equal(stream.headers.get('content-type'),'text/event-stream');
    const reader = stream.body.getReader();
    const {value} = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.ok(text.includes(events.at(-1).id));
    assert.ok(!text.includes(cursor));
    controller.abort();
    await reader.cancel().catch(()=>{});
  });
  await t.test('CLI exit completes a run even when a descendant still holds stdout open', async () => {
    const inherited = await create('后代管道句柄');
    await app.request(`/api/sessions/${inherited.id}/messages`,'POST',{content:'inherited-stdout'});
    const completed = await app.waitFor(inherited.id,['completed','failed'],1800);
    assert.equal(completed.status,'completed',completed.error);
    assert.equal(completed.messages.at(-1).content,'done: inherited-stdout');
  });
  await t.test('busy conflict, bounded queue, upload conflict and cancellation', async () => {
    const long = await create('长任务');
    await app.request(`/api/sessions/${long.id}/messages`,'POST',{content:'sleep'});
    await app.waitFor(long.id,['running']);
    assert.equal((await app.request(`/api/sessions/${long.id}/messages`,'POST',{content:'another'})).status,409);
    assert.equal((await app.request(`/api/sessions/${long.id}/files`,'POST',{name:'late.txt',contentBase64:'eA=='})).status,409);
    const queued = await create('排队任务');
    await app.request(`/api/sessions/${queued.id}/messages`,'POST',{content:'queued task'});
    await app.waitFor(queued.id,['queued']);
    assert.equal((await app.request(`/api/sessions/${queued.id}/cancel`,'POST',{})).status,200);
    assert.equal((await app.waitFor(queued.id,['cancelled'])).runs[0].status,'cancelled');
    const next = await create('继续排队');
    await app.request(`/api/sessions/${next.id}/messages`,'POST',{content:'queued then completed'});
    await app.waitFor(next.id,['queued']);
    await app.request(`/api/sessions/${long.id}/cancel`,'POST',{});
    assert.equal((await app.waitFor(long.id,['cancelled'])).messages.length,1);
    assert.equal((await app.waitFor(next.id,['completed','failed'])).status,'completed');
  });
  await t.test('provider HTTP errors are actionable and provider bodies and tokens stay private', async () => {
    const failed = await create('失败场景');
    await app.request(`/api/sessions/${failed.id}/messages`,'POST',{content:'bridge-fail'});
    const done = await app.waitFor(failed.id,['failed','completed']);
    assert.equal(done.status,'failed');
    assert.match(done.error,/HTTP 401/);
    assert.ok(!JSON.stringify(done).includes('DO-NOT-EXPOSE'));
    assert.ok(!JSON.stringify(done).includes('test-upstream-key'));
    await app.request(`/api/sessions/${failed.id}/messages`,'POST',{content:'secret-error'});
    const redacted = await app.waitFor(failed.id,['failed']);
    assert.match(redacted.error,/\[REDACTED\]/);
    const events = (await app.request(`/api/sessions/${failed.id}/events`)).value;
    assert.ok(!JSON.stringify(events).includes('test-upstream-key'));
    assert.ok(JSON.stringify(events).includes('[REDACTED]'));
  });
  await t.test('server restart preserves conversations, title, runs and files', async () => {
    await app.stop();
    await app.start();
    const restored = (await app.request('/api/sessions/'+first.id)).value;
    assert.equal(restored.title,'修改后名称');
    assert.equal(restored.status,'completed');
    assert.equal(restored.messages.length,4);
    assert.equal(restored.runs.length,2);
    const file = (await app.request(`/api/sessions/${first.id}/file?path=outputs%2Fresult.txt`)).value;
    assert.equal(file.content,'follow up');
  });
  await t.test('graceful shutdown interrupts active and queued jobs without starting new work', async () => {
    const active = await create('停服中的任务');
    await app.request(`/api/sessions/${active.id}/messages`,'POST',{content:'sleep'});
    await app.waitFor(active.id,['running']);
    const queued = await create('停服时排队的任务');
    await app.request(`/api/sessions/${queued.id}/messages`,'POST',{content:'must not start during shutdown'});
    await app.waitFor(queued.id,['queued']);
    await app.shutdown();
    await app.start();
    const restoredActive = (await app.request(`/api/sessions/${active.id}`)).value;
    const restoredQueued = (await app.request(`/api/sessions/${queued.id}`)).value;
    assert.equal(restoredActive.status,'interrupted');
    assert.equal(restoredQueued.status,'interrupted');
    assert.equal(restoredQueued.runs[0].startedAt,null);
    assert.equal(restoredQueued.messages.length,1);
    assert.deepEqual((await app.request(`/api/sessions/${queued.id}/files`)).value,[]);
  });
});
