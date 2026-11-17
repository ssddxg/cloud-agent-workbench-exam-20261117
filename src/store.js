import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
    this.sessions = new Map();
    for (const dir of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^[a-f0-9-]{36}$/.test(dir.name)) continue;
      const file = path.join(this.root, dir.name, 'session.json');
      if (!fs.existsSync(file)) continue;
      try {
        const session = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.sessions.set(session.id, session);
        if (['running', 'queued', 'cancelling'].includes(session.status)) {
          session.status = 'interrupted';
          session.error = '服务已重启，上一次执行被中断。文件和对话已保留，可发送消息继续。';
          for (const run of session.runs) {
            if (!run.finishedAt) { run.status = 'interrupted'; run.finishedAt = new Date().toISOString(); }
          }
          this.save(session);
          this.event(session.id, 'status', { status: 'interrupted', message: session.error });
        }
      } catch (error) { console.error(`Cannot recover session ${dir.name}: ${error.message}`); }
    }
  }
  dir(id) { this.get(id); return path.join(this.root, id); }
  workspace(id) { return path.join(this.dir(id), 'workspace'); }
  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, '会话不存在');
    return s;
  }
  create(title = '新的工作') {
    const now = new Date().toISOString();
    const s = { id: randomUUID(), title: String(title).trim().slice(0, 80) || '新的工作', createdAt: now, updatedAt: now, status: 'idle', threadId: null, messages: [], runs: [], error: null };
    this.sessions.set(s.id, s);
    fs.mkdirSync(this.workspace(s.id), { recursive: true });
    this.save(s);
    return s;
  }
  save(s) {
    s.updatedAt = new Date().toISOString();
    const target = path.join(this.dir(s.id), 'session.json');
    fs.writeFileSync(target + '.tmp', JSON.stringify(s, null, 2));
    fs.renameSync(target + '.tmp', target);
  }
  list() {
    return [...this.sessions.values()].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ messages, runs, ...s }) => ({ ...s, messageCount: messages.length, runCount: runs.length }));
  }
  event(id, type, data) {
    const e = { id: randomUUID(), at: new Date().toISOString(), type, ...data };
    fs.appendFileSync(path.join(this.dir(id), 'events.jsonl'), JSON.stringify(e) + '\n');
    this.onEvent?.(id, e);
    return e;
  }
  events(id) {
    const p = path.join(this.dir(id), 'events.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  }
  // Both lexical traversal and symlink escape must be rejected, including existing parents.
  file(id, relative) {
    const root = fs.realpathSync(this.workspace(id));
    if (!relative || typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\') || relative.split('/').some(x => x === '..' || x.startsWith('.')) || path.isAbsolute(relative) || relative.includes(':')) throw new HttpError(400, '无效文件路径');
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) throw new HttpError(400, '文件超出会话目录');
    let current = root;
    for (const part of path.relative(root, target).split(path.sep)) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new HttpError(403, '不允许访问符号链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return target;
  }
  files(id) {
    const result = [];
    const walk = (dir, prefix = '', depth = 0) => {
      if (depth > 12 || result.length >= 1000) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ['node_modules', '__pycache__'].includes(entry.name)) continue;
        const name = prefix + entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), name + '/', depth + 1);
        else if (entry.isFile()) {
          const stat = fs.statSync(path.join(dir, entry.name));
          result.push({ path: name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
        }
      }
    };
    walk(this.workspace(id));
    return result;
  }
}
