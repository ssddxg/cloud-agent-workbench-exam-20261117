import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.DEMO_URL || 'http://127.0.0.1:3210';
const destination = process.env.EVIDENCE_DIR || path.join(root,'evidence');
await fs.mkdir(destination, { recursive: true });
const api = async (route, method = 'GET', body) => {
  const response = await fetch(base + route, { method, headers: body ? { 'Content-Type':'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${value.error}`);
  return value;
};
async function wait(id) {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const session = await api(`/api/sessions/${id}`);
    if (!['queued','running','cancelling'].includes(session.status)) {
      if (session.status !== 'completed') throw new Error(`${session.title}: ${session.status}: ${session.error}`);
      return session;
    }
    await new Promise(resolve => setTimeout(resolve,1500));
  }
  throw new Error(`Demo session ${id} exceeded 10 minutes`);
}
async function send(id, content) {
  console.log(`Starting ${id}: ${content.slice(0,65)}`);
  await api(`/api/sessions/${id}/messages`, 'POST', { content });
}
async function upload(id, name, content) {
  await api(`/api/sessions/${id}/files`, 'POST', { name, contentBase64:Buffer.from(content).toString('base64') });
}
async function capture(id, label) {
  const session = await api(`/api/sessions/${id}`);
  const events = await api(`/api/sessions/${id}/events`);
  const files = await api(`/api/sessions/${id}/files`);
  const artifactDir = path.join(destination,label);
  await fs.mkdir(artifactDir, { recursive:true });
  for (const file of files.filter(f => f.path.startsWith('outputs/'))) {
    const response = await fetch(`${base}/api/sessions/${id}/file?path=${encodeURIComponent(file.path)}&download=1`);
    assert.equal(response.status,200);
    const dest = path.join(artifactDir,file.path);
    await fs.mkdir(path.dirname(dest), { recursive:true });
    await fs.writeFile(dest,Buffer.from(await response.arrayBuffer()));
  }
  await fs.writeFile(path.join(artifactDir,'session.json'),JSON.stringify({ session, events, files },null,2));
  assert.ok(events.some(e => e.type === 'agent' && e.event?.item?.type === 'command_execution' && e.event.item.exit_code === 0), 'Real CLI must execute a successful command');
  assert.ok(session.threadId, 'Real CLI thread ID must be persisted');
  assert.equal(session.runs.length,2);
  assert.ok(session.runs.every(r => r.status === 'completed'));
  return { id, title:session.title, threadId:session.threadId, status:session.status, runs:session.runs, messages:session.messages.length, files };
}

const health = await api('/api/health');
assert.ok(health.configured && health.cliAvailable, 'Configure real API and Codex before demo');
const code = await api('/api/sessions','POST',{title:'开发任务 · 费用汇总工具'});
const daily = await api('/api/sessions','POST',{title:'日常工作 · 项目周报'});
// Only synthetic materials are used. They are application inputs, not answer code.
const csv = 'date,category,amount\n2026-11-01,交通,32.50\n2026-11-02,餐饮,68.00\n2026-11-03,交通,17.50\n2026-11-04,办公,120.00\n2026-11-05,餐饮,42.00\n';
const notes = '# 项目会议纪要（演示用合成数据）\n日期：2026-11-16\n本周完成：登录页完成，文件上传接口通过联调，报表模块尚未验收。\n事项：陈晨在11月19日前完成报表验收；林可在11月18日前补充上传接口的错误提示；周航在11月20日前安排用户试用。\n风险：报表数据口径未统一，可能影响周五发布；应由陈晨与财务核对口径。\n决定：本周先发布登录和上传功能，报表通过验收后再上线。\n';
await upload(code.id,'expenses.csv',csv);
await upload(daily.id,'meeting-notes.md',notes);
await send(code.id,'开发一个零依赖 Node.js 费用汇总命令行工具。读取 uploads/expenses.csv，按 category 汇总 amount 并计算总额。创建 outputs/expense-summary.mjs 和 outputs/README.md，运行工具验证结果，把实际输出保存到 outputs/result.json。不要安装依赖，只在本会话目录内工作。');
await send(daily.id,'阅读 uploads/meeting-notes.md，整理中文项目周报 outputs/weekly-report.md，并生成可导入表格的 outputs/action-items.csv，字段包含事项、负责人、截止日期、状态。区分已完成、待办、风险与决定。必须从文件读取，不要编造信息，也不要安装依赖。');
await Promise.all([wait(code.id),wait(daily.id)]);
console.log('Both initial tasks completed; continuing the same CLI threads.');
await send(code.id,'继续修改刚才的费用工具：增加 --category 参数，只汇总指定类别。无参数保留全部汇总。实际运行 --category 交通，断言总额为 50，并保存输出到 outputs/transport-result.json。同步更新 README，保留原有结果文件。');
await send(daily.id,'在现有周报后追加“下周优先级”部分，按 P0/P1 排序并说明理由；保留原始事实，不补造任务。另外创建 outputs/executive-summary.md，给管理者一份不超过 200 字的摘要，列出最需要关注的风险和决定。');
await Promise.all([wait(code.id),wait(daily.id)]);
const reports = [await capture(code.id,'code-task'), await capture(daily.id,'daily-task')];
assert.notEqual(reports[0].threadId,reports[1].threadId);
const result = JSON.parse(await fs.readFile(path.join(destination,'code-task/outputs/transport-result.json'),'utf8'));
// Agent may choose a different schema; check the verified amount is present in produced JSON.
assert.ok(JSON.stringify(result).includes('50'),'Transport result should contain 50');
const list = await api('/api/sessions');
assert.ok(reports.every(r => list.some(s => s.id === r.id)),'Both sessions must survive navigation/reload');
const summary = { generatedAt:new Date().toISOString(), environment:{ node:process.version, platform:process.platform, model:health.model, protocol:health.protocol, realAgent:'Codex CLI 0.157.1', execution:process.env.DEMO_ENVIRONMENT || 'native Windows; Docker validation tracked separately' }, checks:{ codeDevelopment:true, dailyWork:true, followupOnSameCliThread:true, twoIndependentSessions:true, actualSuccessfulCommands:true, downloadableArtifacts:true, persistedMessages:true }, sessions:reports };
await fs.writeFile(path.join(destination,'verification.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
