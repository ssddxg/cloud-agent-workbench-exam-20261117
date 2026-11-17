import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { createZip, crc32 } from "../src/archive.js";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Read the public ZIP record layout independently of the writer. Every entry's
// central-directory metadata must point to a matching local header and payload.
function readStoredZip(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  assert.equal(directoryOffset + directorySize, end);
  assert.equal(buffer.readUInt16LE(end + 20), 0);
  let cursor = directoryOffset;
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const flags = buffer.readUInt16LE(cursor + 8);
    assert.ok(flags & 0x0800, "UTF-8 entry names must be marked explicitly");
    assert.equal(
      buffer.readUInt16LE(cursor + 10),
      0,
      "Archive uses standard stored entries",
    );
    const checksum = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 20);
    assert.equal(buffer.readUInt32LE(cursor + 24), size);
    const nameSize = buffer.readUInt16LE(cursor + 28);
    const extraSize = buffer.readUInt16LE(cursor + 30);
    const commentSize = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameSize)
      .toString("utf8");
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(buffer.readUInt32LE(localOffset + 14), checksum);
    assert.equal(buffer.readUInt32LE(localOffset + 18), size);
    const localNameSize = buffer.readUInt16LE(localOffset + 26);
    const localExtraSize = buffer.readUInt16LE(localOffset + 28);
    assert.equal(
      buffer
        .subarray(localOffset + 30, localOffset + 30 + localNameSize)
        .toString("utf8"),
      name,
    );
    const dataOffset = localOffset + 30 + localNameSize + localExtraSize;
    entries.set(name, {
      data: buffer.subarray(dataOffset, dataOffset + size),
      checksum,
    });
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  assert.equal(cursor, end);
  return entries;
}

test("ZIP downloads retain Unicode names, binary bytes and standard CRC values", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  const binary = Buffer.from([0, 255, 1, 128, 42, 0]);
  const zip = createZip([
    { name: "outputs/中文报告.md", data: Buffer.from("123456789") },
    { name: "outputs/assets/result.bin", data: binary },
    { name: "outputs/empty.txt", data: Buffer.alloc(0) },
  ]);
  const entries = readStoredZip(zip);
  assert.equal(entries.size, 3);
  assert.equal(
    entries.get("outputs/中文报告.md").data.toString("utf8"),
    "123456789",
  );
  assert.equal(entries.get("outputs/中文报告.md").checksum, 0xcbf43926);
  assert.deepEqual(entries.get("outputs/assets/result.bin").data, binary);
  assert.equal(entries.get("outputs/empty.txt").checksum, 0);
});

test("session organization persists and pinning takes priority over recency", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-organize-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const store = new Store(temp);
  const older = store.create("保留的工作");
  const newer = store.create("最近的工作");
  assert.equal(older.pinned, false);
  assert.equal(older.archived, false);
  older.pinned = true;
  older.archived = true;
  store.save(older);
  newer.updatedAt = "2099-01-01T00:00:00.000Z";
  fs.writeFileSync(
    path.join(store.dir(newer.id), "session.json"),
    JSON.stringify(newer),
  );
  assert.equal(store.list()[0].id, older.id);
  const restored = new Store(temp);
  assert.equal(restored.get(older.id).pinned, true);
  assert.equal(restored.get(older.id).archived, true);
  assert.equal(restored.list()[0].id, older.id);
});

async function freePort() {
  const listener = http.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function harness() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-enhancement-"));
  const dataDir = path.join(temp, "data");
  const fake = path.join(temp, "fake-codex.cjs.js");
  fs.writeFileSync(
    fake,
    `
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000002'}));
  if (input === 'hold') { setInterval(() => {}, 1000); return; }
  const fs=require('node:fs');fs.mkdirSync('outputs',{recursive:true});
  fs.writeFileSync('outputs/result.md', '# 结果\\n' + input);
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'已完成。\\n\\n\x60\x60\x60js\\nconsole.log(42);\\n\x60\x60\x60'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:11,output_tokens:7}}));
});
`,
  );
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  let logs = "";
  const request = async (route, method = "GET", body) => {
    const response = await fetch(base + route, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      value = bytes.toString("utf8");
    }
    return { status: response.status, headers: response.headers, bytes, value };
  };
  const start = async () => {
    child = spawn(process.execPath, ["src/server.js"], {
      cwd: project,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        DATA_DIR: dataDir,
        CODEX_BIN: fake,
        AGENT_API_KEY: "test-only-key",
        AGENT_MODEL: "test-model",
        MAX_CONCURRENT_RUNS: "1",
        RUN_TIMEOUT_MS: "15000",
      },
    });
    child.stdout.on("data", (chunk) => (logs += chunk));
    child.stderr.on("data", (chunk) => (logs += chunk));
    for (let i = 0; i < 150; i++) {
      try {
        if ((await request("/api/health")).status === 200) return;
      } catch {}
      if (child.exitCode !== null) throw new Error(logs);
      await sleep(20);
    }
    throw new Error(`Server startup timed out: ${logs}`);
  };
  const waitFor = async (id, states) => {
    for (let i = 0; i < 250; i++) {
      const result = (await request(`/api/sessions/${id}`)).value;
      if (states.includes(result.status)) return result;
      await sleep(20);
    }
    throw new Error(`Task did not reach ${states}: ${logs}`);
  };
  const stop = async () => {
    if (child?.exitCode !== null) return;
    try {
      const sessions = (await request("/api/sessions")).value;
      for (const s of sessions)
        if (["running", "queued", "cancelling"].includes(s.status)) {
          await request(`/api/sessions/${s.id}/cancel`, "POST", {});
          await waitFor(s.id, ["cancelled", "completed", "failed"]);
        }
    } catch {}
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(4500)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  await start();
  return {
    temp,
    dataDir,
    request,
    start,
    stop,
    waitFor,
    async close() {
      await stop();
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}

test(
  "organized sessions and downloadable deliverables preserve existing work",
  { timeout: 30000 },
  async (t) => {
    const app = await harness();
    t.after(() => app.close());
    const create = async (title) =>
      (await app.request("/api/sessions", "POST", { title })).value;
    const first = await create("开发工具");
    const route = `/api/sessions/${first.id}`;

    await t.test(
      "metadata patch is durable, validates types atomically and does not rewrite chat",
      async () => {
        let changed = await app.request(route, "PATCH", {
          title: "整理后的工作",
          pinned: true,
        });
        assert.equal(changed.status, 200);
        assert.equal(changed.value.pinned, true);
        assert.equal(changed.value.archived, false);
        const invalid = await app.request(route, "PATCH", {
          title: "不应保存",
          pinned: "yes",
        });
        assert.equal(invalid.status, 400);
        for (const payload of [
          {},
          { archived: 1 },
          { title: " " },
          { title: "不应保存", unknown: true },
        ])
          assert.equal(
            (await app.request(route, "PATCH", payload)).status,
            400,
          );
        changed = await app.request(route);
        assert.equal(changed.value.title, "整理后的工作");
        assert.deepEqual(changed.value.messages, []);
        assert.equal(
          (await app.request(route, "PATCH", { archived: true })).status,
          200,
        );
        await app.stop();
        await app.start();
        const restored = (await app.request(route)).value;
        assert.equal(restored.pinned, true);
        assert.equal(restored.archived, true);
      },
    );

    await t.test(
      "archive prevents mutation until restore and busy jobs cannot be archived",
      async () => {
        assert.equal(
          (
            await app.request(route + "/messages", "POST", {
              content: "must not run",
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await app.request(route + "/files", "POST", {
              name: "notes.txt",
              contentBase64: "eA==",
            })
          ).status,
          409,
        );
        assert.equal((await app.request(route)).value.messages.length, 0);
        assert.equal(
          (await app.request(route, "PATCH", { archived: false })).status,
          200,
        );
        await app.request(route + "/messages", "POST", { content: "hold" });
        await app.waitFor(first.id, ["running"]);
        assert.equal(
          (await app.request(route, "PATCH", { archived: true })).status,
          409,
        );
        assert.equal((await app.request(route + "/artifacts.zip")).status, 409);
        await app.request(route + "/cancel", "POST", {});
        await app.waitFor(first.id, ["cancelled"]);
      },
    );

    await t.test(
      "ZIP contains only outputs and preserves text, Unicode and binary content",
      async () => {
        assert.equal((await app.request(route + "/artifacts.zip")).status, 404);
        const workspace = path.join(
          app.dataDir,
          "sessions",
          first.id,
          "workspace",
        );
        fs.mkdirSync(path.join(workspace, "outputs", "assets"), {
          recursive: true,
        });
        fs.mkdirSync(path.join(workspace, "uploads"), { recursive: true });
        fs.writeFileSync(
          path.join(workspace, "outputs", "中文报告.md"),
          "# 实际成果\n",
        );
        fs.writeFileSync(
          path.join(workspace, "outputs", "assets", "raw.bin"),
          Buffer.from([0, 255, 20]),
        );
        fs.writeFileSync(path.join(workspace, "outputs", ".private"), "hidden");
        fs.writeFileSync(
          path.join(workspace, "uploads", "private-notes.txt"),
          "not a deliverable",
        );
        fs.writeFileSync(
          path.join(workspace, "scratch.txt"),
          "not a deliverable",
        );
        try {
          fs.symlinkSync(
            path.join(workspace, "uploads", "private-notes.txt"),
            path.join(workspace, "outputs", "link.txt"),
          );
        } catch (error) {
          if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
        }
        const result = await app.request(route + "/artifacts.zip");
        assert.equal(result.status, 200);
        assert.equal(result.headers.get("content-type"), "application/zip");
        assert.match(result.headers.get("content-disposition"), /attachment/);
        const entries = readStoredZip(result.bytes);
        assert.deepEqual([...entries.keys()].sort(), [
          "outputs/assets/raw.bin",
          "outputs/中文报告.md",
        ]);
        assert.equal(
          entries.get("outputs/中文报告.md").data.toString("utf8"),
          "# 实际成果\n",
        );
        assert.deepEqual(
          entries.get("outputs/assets/raw.bin").data,
          Buffer.from([0, 255, 20]),
        );
      },
    );

    await t.test(
      "oversized artifact bundles fail without reading an unbounded response",
      async () => {
        const large = path.join(
          app.dataDir,
          "sessions",
          first.id,
          "workspace",
          "outputs",
          "large.bin",
        );
        fs.writeFileSync(large, "");
        fs.truncateSync(large, 33 * 1024 * 1024);
        const result = await app.request(route + "/artifacts.zip");
        assert.equal(result.status, 413);
        assert.ok(result.bytes.length < 10000);
        fs.unlinkSync(large);
      },
    );

    await t.test(
      "Markdown export is a readable transcript while JSON export retains structured data",
      async () => {
        await app.request(route + "/messages", "POST", {
          content: "请验证并输出结果。",
        });
        const completed = await app.waitFor(first.id, ["completed", "failed"]);
        assert.equal(completed.status, "completed", completed.error);
        const markdown = await app.request(route + "/export?format=markdown");
        assert.equal(markdown.status, 200);
        assert.match(markdown.headers.get("content-type"), /text\/markdown/);
        assert.match(markdown.headers.get("content-disposition"), /\.md/);
        assert.ok(markdown.value.includes("整理后的工作"));
        assert.ok(markdown.value.includes("请验证并输出结果。"));
        assert.ok(markdown.value.includes("```js\nconsole.log(42);\n```"));
        assert.ok(markdown.value.includes(completed.messages.at(-1).at));
        const structured = await app.request(route + "/export");
        assert.equal(structured.status, 200);
        assert.equal(structured.value.session.id, first.id);
        assert.ok(Array.isArray(structured.value.events));
        assert.ok(Array.isArray(structured.value.files));
      },
    );
  },
);
