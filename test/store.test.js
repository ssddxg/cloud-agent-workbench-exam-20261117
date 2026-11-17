import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, HttpError } from '../src/store.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'sessions'));
  return { root, store, session: store.create('测试工作') };
}

test('session messages, CLI thread identity and files survive a fresh Store', t => {
  const { store, session } = fixture(t);
  session.threadId = 'persistent-cli-thread';
  session.messages.push({ role: 'user', content: '继续昨天的工作' });
  session.status = 'completed';
  store.save(session);
  fs.mkdirSync(store.file(session.id, 'outputs'), { recursive: true });
  fs.writeFileSync(store.file(session.id, 'outputs/report.md'), '# 已完成');
  const recovered = new Store(store.root);
  assert.equal(recovered.get(session.id).threadId, 'persistent-cli-thread');
  assert.equal(recovered.get(session.id).messages[0].content, '继续昨天的工作');
  assert.equal(recovered.get(session.id).status, 'completed');
  assert.equal(recovered.files(session.id)[0].path, 'outputs/report.md');
  assert.equal(fs.readFileSync(recovered.file(session.id, 'outputs/report.md'), 'utf8'), '# 已完成');
});

test('unfinished runs recover as interrupted without erasing usable work', t => {
  const { store, session } = fixture(t);
  session.status = 'running';
  session.messages.push({ role: 'user', content: '原始请求' });
  session.runs.push({ id: 'run-1', status: 'running', startedAt: '2026-11-17T12:00:00Z', finishedAt: null });
  store.save(session);
  const recovered = new Store(store.root);
  const result = recovered.get(session.id);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.runs[0].status, 'interrupted');
  assert.ok(result.runs[0].finishedAt);
  assert.equal(result.messages[0].content, '原始请求');
  assert.equal(recovered.events(session.id).at(-1).status, 'interrupted');
});

test('unknown sessions and traversal cannot access another workspace', t => {
  const { store, session } = fixture(t);
  assert.throws(() => store.get('missing'), error => error instanceof HttpError && error.status === 404);
  for (const input of ['', '../secret', 'a/../../secret', '/etc/passwd', 'C:/secret', 'a\\secret', '.env', 'uploads/.env', 'a\0b']) {
    assert.throws(() => store.file(session.id, input), { status: 400 }, input);
  }
  assert.equal(store.file(session.id, 'uploads/正常材料.csv'), path.join(store.workspace(session.id), 'uploads', '正常材料.csv'));
});

test('directory links cannot expose material outside the workspace', t => {
  const { root, store, session } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
  try { fs.symlinkSync(outside, path.join(store.workspace(session.id), 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('OS does not permit test symlinks'); throw error; }
  assert.throws(() => store.file(session.id, 'shortcut/secret.txt'), { status: 403 });
  assert.deepEqual(store.files(session.id), []);
});

test('event replay retains ordered durable history and tolerates a torn final line', t => {
  const { store, session } = fixture(t);
  const one = store.event(session.id, 'status', { status: 'running' });
  const two = store.event(session.id, 'status', { status: 'completed' });
  fs.appendFileSync(path.join(store.dir(session.id), 'events.jsonl'), '{"partial":');
  const recovered = new Store(store.root);
  assert.deepEqual(recovered.events(session.id).map(e => e.id), [one.id, two.id]);
  assert.notEqual(one.id, two.id);
  assert.equal(recovered.list()[0].messageCount, 0);
  assert.equal(recovered.list()[0].messages, undefined);
});
