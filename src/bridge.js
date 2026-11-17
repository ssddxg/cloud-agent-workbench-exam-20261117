import { randomUUID } from 'node:crypto';

// Translate only the public Responses/tool-call contract. The actual agent loop,
// shell commands, patch application and conversation storage belong to Codex CLI.
export function toChat(input) {
  const messages = [];
  if (input.instructions) messages.push({ role: 'system', content: input.instructions });
  for (const item of typeof input.input === 'string' ? [{ role: 'user', content: input.input }] : input.input || []) {
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments } };
      const last = messages.at(-1);
      if (last?.role === 'assistant' && last.tool_calls) last.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) });
    } else if (item.type === 'message' || item.role) {
      const content = typeof item.content === 'string' ? item.content : (item.content || []).map(c => c.text || '').join('\n');
      messages.push({ role: item.role === 'developer' ? 'system' : item.role || 'user', content });
    }
    // Reasoning items are private provider state and are intentionally not forwarded.
  }
  const tools = (input.tools || []).filter(t => t.type === 'function' || t.type === 'custom').map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } } }));
  return { model: input.model, messages, ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}), stream: false };
}

export async function handleBridge(req, res, body, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  const abort = () => controller.abort();
  res.on('close', abort);
  try {
    const route = config.protocol === 'responses' ? '/responses' : '/chat/completions';
    const payload = config.protocol === 'responses' ? body : toChat(body);
    payload.model = config.model;
    const upstream = await fetch(config.baseUrl.replace(/\/$/, '') + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(payload), signal: controller.signal
    });
    if (!upstream.ok) {
      // Never return provider bodies: some services echo request headers or keys.
      const error = new Error(`模型服务返回 HTTP ${upstream.status}；请检查 API 地址、模型、凭据或额度。`);
      error.status = upstream.status;
      throw error;
    }
    if (config.protocol === 'responses') {
      res.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') || 'text/event-stream' });
      for await (const chunk of upstream.body) res.write(chunk);
      return res.end();
    }
    const answer = await upstream.json();
    const choice = answer.choices?.[0];
    if (!choice?.message) throw new Error('模型响应缺少 choices[0].message；请检查协议配置。');
    const id = 'resp_' + randomUUID().replaceAll('-', '');
    const output = [];
    if (choice.message.content) output.push({ id: 'msg_' + randomUUID().replaceAll('-', ''), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: choice.message.content, annotations: [] }] });
    for (const call of choice.message.tool_calls || []) {
      const custom = (body.tools || []).some(t => t.type === 'custom' && t.name === call.function.name);
      output.push({ id: 'fc_' + randomUUID().replaceAll('-', ''), type: custom ? 'custom_tool_call' : 'function_call', status: 'completed', call_id: call.id, name: call.function.name, ...(custom ? { input: JSON.parse(call.function.arguments).input } : { arguments: call.function.arguments }) });
    }
    if (!output.length) throw new Error('模型返回了空内容，未完成任务。');
    const usage = { input_tokens: answer.usage?.prompt_tokens || 0, output_tokens: answer.usage?.completion_tokens || 0, total_tokens: answer.usage?.total_tokens || 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
    const response = { id, object: 'response', created_at: Math.floor(Date.now()/1000), model: config.model, status: 'in_progress', output: [], usage: null };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    let seq = 0;
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
    emit('response.created', { response });
    emit('response.in_progress', { response });
    for (let i = 0; i < output.length; i++) {
      const item = output[i];
      emit('response.output_item.added', { output_index: i, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : item.type === 'custom_tool_call' ? { input: '' } : { arguments: '' }) } });
      if (item.type === 'message') {
        emit('response.content_part.added', { item_id: item.id, output_index: i, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        emit('response.output_text.delta', { item_id: item.id, output_index: i, content_index: 0, delta: item.content[0].text });
        emit('response.output_text.done', { item_id: item.id, output_index: i, content_index: 0, text: item.content[0].text });
        emit('response.content_part.done', { item_id: item.id, output_index: i, content_index: 0, part: item.content[0] });
      } else if (item.type === 'function_call') {
        emit('response.function_call_arguments.delta', { item_id: item.id, output_index: i, delta: item.arguments });
        emit('response.function_call_arguments.done', { item_id: item.id, output_index: i, arguments: item.arguments });
      } else {
        emit('response.custom_tool_call_input.delta', { item_id: item.id, output_index: i, delta: item.input });
        emit('response.custom_tool_call_input.done', { item_id: item.id, output_index: i, input: item.input });
      }
      emit('response.output_item.done', { output_index: i, item });
    }
    emit('response.completed', { response: { ...response, status: 'completed', output, usage } });
    res.end();
    config.onUsage?.(usage);
  } catch (error) {
    const message = error.name === 'AbortError' ? '模型请求超时或已取消。' : error.message;
    config.onError?.(message);
    if (!res.headersSent) { res.writeHead(error.status >= 400 && error.status < 600 ? error.status : 502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message, type: 'upstream_error' } })); }
    else res.end();
  } finally { clearTimeout(timeout); res.off('close', abort); }
}
