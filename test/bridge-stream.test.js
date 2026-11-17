// Protocol regressions use local fake HTTP providers only. They do not spend
// model credits and are separate from the real Codex/Docker demonstration.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { handleBridge } from '../src/bridge.js';

async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fixture(t, protocol, reply) {
  const requests = [];
  const usage = [];
  const errors = [];
  const upstream = http.createServer(async (req, res) => {
    requests.push({path:req.url, authorization:req.headers.authorization, body:await bodyOf(req)});
    reply(req, res);
  });
  upstream.listen(0,'127.0.0.1');
  await once(upstream,'listening');
  const bridge = http.createServer(async (req, res) => {
    await handleBridge(req,res,await bodyOf(req), {
      protocol,
      baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,
      apiKey:'local-test-provider-key',
      model:'configured-test-model',
      onUsage:value=>usage.push(value),
      onError:value=>errors.push(value)
    });
  });
  bridge.listen(0,'127.0.0.1');
  await once(bridge,'listening');
  t.after(async () => {
    for (const server of [bridge,upstream]) {
      server.closeAllConnections();
      await new Promise(resolve=>server.close(resolve));
    }
  });
  return {
    requests,usage,errors,
    async send(body) {
      const response = await fetch(`http://127.0.0.1:${bridge.address().port}/responses`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      return {status:response.status,headers:response.headers,text:await response.text()};
    }
  };
}

function parseEvents(text) {
  return text.split('\n\n').filter(Boolean).map(block => {
    const type = block.split('\n').find(line=>line.startsWith('event: '))?.slice(7);
    const data = JSON.parse(block.split('\n').find(line=>line.startsWith('data: ')).slice(6));
    assert.equal(data.type,type);
    return data;
  });
}

test('Chat response becomes complete Responses SSE text/function/custom lifecycle with usage',async t => {
  const app = await fixture(t,'chat',(_req,res) => {
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({
      choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:'正在处理材料。',tool_calls:[
        {id:'call_shell_1',type:'function',function:{name:'exec_command',arguments:'{"cmd":"pwd"}'}},
        {id:'call_patch_2',type:'function',function:{name:'apply_patch',arguments:JSON.stringify({input:'*** Begin Patch\n*** End Patch'})}}
      ]}}],
      usage:{prompt_tokens:23,completion_tokens:11,total_tokens:34}
    }));
  });
  const response = await app.send({
    model:'untrusted-client-model',
    instructions:'Work in the current workspace.',
    input:[{type:'message',role:'user',content:[{type:'input_text',text:'请处理上传材料。'}]}],
    tools:[
      {type:'function',name:'exec_command',description:'Execute command',parameters:{type:'object',properties:{cmd:{type:'string'}},required:['cmd']}},
      {type:'custom',name:'apply_patch',description:'Apply a patch'}
    ],
    stream:true
  });
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'text/event-stream');
  const events = parseEvents(response.text);
  assert.deepEqual(events.map(event=>event.sequence_number),events.map((_event,index)=>index));
  assert.equal(events[0].type,'response.created');
  assert.equal(events[1].type,'response.in_progress');
  assert.equal(events.at(-1).type,'response.completed');
  const completed = events.at(-1).response;
  assert.equal(completed.status,'completed');
  assert.equal(completed.model,'configured-test-model');
  assert.equal(completed.output.length,3);
  const [message,shell,patch] = completed.output;
  assert.equal(message.type,'message');
  assert.equal(message.role,'assistant');
  assert.equal(message.content[0].text,'正在处理材料。');
  assert.ok(events.some(event=>event.type==='response.output_text.delta' && event.delta===message.content[0].text));
  assert.ok(events.some(event=>event.type==='response.content_part.done' && event.item_id===message.id));
  assert.equal(shell.type,'function_call');
  assert.equal(shell.name,'exec_command');
  assert.equal(shell.call_id,'call_shell_1');
  assert.deepEqual(JSON.parse(shell.arguments),{cmd:'pwd'});
  assert.ok(events.some(event=>event.type==='response.function_call_arguments.done' && event.item_id===shell.id && event.arguments===shell.arguments));
  assert.equal(patch.type,'custom_tool_call');
  assert.equal(patch.call_id,'call_patch_2');
  assert.equal(patch.name,'apply_patch');
  assert.equal(patch.input,'*** Begin Patch\n*** End Patch');
  assert.ok(events.some(event=>event.type==='response.custom_tool_call_input.done' && event.item_id===patch.id && event.input===patch.input));
  for (let index=0;index<completed.output.length;index++) {
    const item = completed.output[index];
    assert.ok(events.some(event=>event.type==='response.output_item.added' && event.output_index===index && event.item.id===item.id));
    assert.ok(events.some(event=>event.type==='response.output_item.done' && event.output_index===index && event.item.id===item.id && event.item.status==='completed'));
  }
  assert.deepEqual(completed.usage,{input_tokens:23,output_tokens:11,total_tokens:34,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}});
  assert.deepEqual(app.usage,[completed.usage]);
  assert.deepEqual(app.errors,[]);
  assert.equal(app.requests.length,1);
  const upstream = app.requests[0];
  assert.equal(upstream.path,'/v1/chat/completions');
  assert.equal(upstream.authorization,'Bearer local-test-provider-key');
  assert.equal(upstream.body.model,'configured-test-model');
  assert.equal(upstream.body.stream,false);
  assert.equal(upstream.body.parallel_tool_calls,false);
  assert.equal(upstream.body.tools[1].function.parameters.required[0],'input');
  assert.equal(response.text.includes('local-test-provider-key'),false);
});

test('native Responses provider stream is forwarded byte-for-byte with configured model',async t => {
  const native = 'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_native","status":"in_progress","output":[]}}\n\n'
    + 'event: response.completed\ndata: {"type":"response.completed","sequence_number":1,"response":{"id":"resp_native","status":"completed","output":[]}}\n\n';
  const app = await fixture(t,'responses',(_req,res) => {
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write(native.slice(0,91));
    res.end(native.slice(91));
  });
  const input = {model:'client-override',input:'native request',stream:true,previous_response_id:'resp_previous'};
  const response = await app.send(input);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'text/event-stream');
  assert.equal(response.text,native);
  assert.equal(app.requests[0].path,'/v1/responses');
  assert.deepEqual(app.requests[0].body,{...input,model:'configured-test-model'});
  assert.deepEqual(app.errors,[]);
});
