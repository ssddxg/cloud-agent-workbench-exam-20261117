import test from 'node:test';
import assert from 'node:assert/strict';
import { toChat } from '../src/bridge.js';

test('Responses instructions and developer messages become Chat system context', () => {
  const result = toChat({ model: 'test-model', instructions: 'Use uploaded facts.', input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Do not invent numbers.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read notes' }, { type: 'input_text', text: 'and summarize.' }] },
    { type: 'reasoning', encrypted_content: 'provider-private' }
  ] });
  assert.deepEqual(result.messages, [
    { role: 'system', content: 'Use uploaded facts.' },
    { role: 'system', content: 'Do not invent numbers.' },
    { role: 'user', content: 'Read notes\nand summarize.' }
  ]);
  assert.equal(result.model, 'test-model');
  assert.equal(JSON.stringify(result).includes('provider-private'), false);
});

test('ordinary function calls retain call IDs and matching tool outputs', () => {
  const result = toChat({ input: [
    { type: 'function_call', call_id: 'call-read', name: 'exec_command', arguments: '{"cmd":"cat notes.md"}' },
    { type: 'function_call', call_id: 'call-list', name: 'exec_command', arguments: '{"cmd":"ls"}' },
    { type: 'function_call_output', call_id: 'call-read', output: { exit_code: 0, output: 'notes' } },
    { type: 'function_call_output', call_id: 'call-list', output: 'notes.md' }
  ] });
  assert.equal(result.messages[0].tool_calls.length, 2);
  assert.equal(result.messages[0].tool_calls[0].id, 'call-read');
  assert.equal(result.messages[1].tool_call_id, 'call-read');
  assert.deepEqual(JSON.parse(result.messages[1].content), { exit_code: 0, output: 'notes' });
  assert.equal(result.messages[2].content, 'notes.md');
});

test('custom apply_patch calls are reversible through a JSON string input', () => {
  const patch = '*** Begin Patch\n*** Add File: report.md\n+# Report\n*** End Patch';
  const result = toChat({ input: [
    { type: 'custom_tool_call', call_id: 'patch-1', name: 'apply_patch', input: patch },
    { type: 'custom_tool_call_output', call_id: 'patch-1', output: 'Success' }
  ], tools: [ { type: 'custom', name: 'apply_patch', description: 'Apply a patch' } ] });
  assert.equal(JSON.parse(result.messages[0].tool_calls[0].function.arguments).input, patch);
  assert.equal(result.messages[1].tool_call_id, 'patch-1');
  assert.equal(result.messages[1].content, 'Success');
  assert.equal(result.tools[0].function.parameters.properties.input.type, 'string');
  assert.equal(result.parallel_tool_calls, false);
});

test('plain prompts and declared JSON schemas work without synthetic tool state', () => {
  const noTools = toChat({ input: 'hello' });
  assert.deepEqual(noTools.messages, [{ role: 'user', content: 'hello' }]);
  assert.equal(noTools.tools, undefined);
  const schema = { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] };
  const result = toChat({ input: [], tools: [{ type: 'function', name: 'shell', parameters: schema }, { type: 'web_search' }] });
  assert.equal(result.tools.length, 1);
  assert.deepEqual(result.tools[0].function.parameters, schema);
});
