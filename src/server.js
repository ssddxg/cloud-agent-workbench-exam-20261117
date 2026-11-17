import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Store, HttpError } from "./store.js";
import { Runner } from "./runner.js";
import { handleBridge } from "./bridge.js";
import { createZip } from "./archive.js";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const config = {
  port: Number(process.env.PORT || 3210),
  host: process.env.HOST || "127.0.0.1",
  dataDir: path.resolve(process.env.DATA_DIR || path.join(project, "data")),
  apiKey: process.env.AGENT_API_KEY || "",
  baseUrl: process.env.AGENT_BASE_URL || "https://api.openai.com/v1",
  model: process.env.AGENT_MODEL || "gpt-5.1-codex-mini",
  protocol: process.env.AGENT_PROTOCOL || "chat",
  bridgeToken: randomBytes(32).toString("hex"),
  maxRuns: Math.max(
    1,
    Math.min(4, Number(process.env.MAX_CONCURRENT_RUNS) || 2),
  ),
  timeout: Math.max(5000, Number(process.env.RUN_TIMEOUT_MS) || 600000),
};
if (!["chat", "responses"].includes(config.protocol))
  throw new Error("AGENT_PROTOCOL must be chat or responses");
const store = new Store(path.join(config.dataDir, "sessions"));
const runner = new Runner(store, config);
const clients = new Map();
store.onEvent = (id, event) => {
  for (const res of clients.get(id) || [])
    res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
};
const json = (res, value, status = 200) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
async function readBody(req, max = 15_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max)
      throw new HttpError(413, "上传内容超过限制（单文件最多 10 MB）");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求 JSON 无效");
  }
}
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const busy = (s) => ["running", "queued", "cancelling"].includes(s.status);
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  );
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const route = url.pathname;
    // Host/Origin checks prevent drive-by websites from controlling a localhost agent.
    const host = req.headers.host || "";
    if (
      !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) &&
      host !== `${config.host}:${config.port}`
    )
      throw new HttpError(403, "Host not allowed");
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${host}` &&
      req.headers.origin !== `https://${host}`
    )
      throw new HttpError(403, "跨站请求已拒绝");
    if (route === "/internal/v1/responses" && req.method === "POST") {
      if (req.headers.authorization !== `Bearer ${config.bridgeToken}`)
        throw new HttpError(403, "Forbidden");
      return await handleBridge(req, res, await readBody(req, 12_000_000), {
        ...config,
        onError: (msg) => console.error("[model]", msg),
      });
    }
    if (route === "/api/health" && req.method === "GET")
      return json(res, {
        ok: true,
        configured: !!config.apiKey,
        model: config.model,
        protocol: config.protocol,
        cliAvailable: !!runner.bin,
        activeRuns: runner.active.size,
        queuedRuns: runner.queue.length,
        maxConcurrentRuns: config.maxRuns,
      });
    if (route === "/api/sessions") {
      if (req.method === "GET") return json(res, store.list());
      if (req.method === "POST")
        return json(res, store.create((await readBody(req)).title), 201);
    }
    const match = route.match(
      /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(messages|cancel|events|stream|files|file|export|artifacts\.zip))?$/,
    );
    if (match) {
      const [, id, action] = match;
      const session = store.get(id);
      if (!action && req.method === "GET") return json(res, session);
      if (!action && req.method === "PATCH") {
        return json(res, store.update(id, await readBody(req)));
      }
      if (action === "messages" && req.method === "POST") {
        const { content } = await readBody(req);
        if (
          typeof content !== "string" ||
          !content.trim() ||
          content.length > 32000
        )
          throw new HttpError(400, "请输入 1–32000 字符的消息");
        return json(res, { runId: runner.submit(id, content.trim()).id }, 202);
      }
      if (action === "cancel" && req.method === "POST") {
        runner.stop(id);
        return json(res, { ok: true });
      }
      if (action === "events" && req.method === "GET")
        return json(res, store.events(id));
      if (action === "stream" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const events = store.events(id);
        const last = req.headers["last-event-id"];
        const found = events.findIndex((e) => e.id === last);
        for (const event of events.slice(found >= 0 ? found + 1 : 0))
          res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        if (!clients.has(id)) clients.set(id, new Set());
        clients.get(id).add(res);
        const heartbeat = setInterval(
          () => res.write(": heartbeat\n\n"),
          15000,
        );
        req.on("close", () => {
          clearInterval(heartbeat);
          clients.get(id)?.delete(res);
          if (!clients.get(id)?.size) clients.delete(id);
        });
        return;
      }
      if (action === "files" && req.method === "GET")
        return json(res, store.files(id));
      if (action === "files" && req.method === "POST") {
        if (session.archived)
          throw new HttpError(409, "此会话已归档，请先恢复再添加材料");
        if (busy(session))
          throw new HttpError(
            409,
            "请等待当前任务结束后上传，避免文件被同时修改",
          );
        const { name, contentBase64 } = await readBody(req);
        if (
          typeof name !== "string" ||
          !name.trim() ||
          name.includes("/") ||
          name.includes("\\") ||
          name.startsWith(".") ||
          name.length > 180
        )
          throw new HttpError(400, "文件名无效");
        if (
          typeof contentBase64 !== "string" ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)
        )
          throw new HttpError(400, "文件内容格式无效");
        const data = Buffer.from(contentBase64, "base64");
        if (data.length > 10_000_000)
          throw new HttpError(413, "文件超过 10 MB");
        const dest = store.file(id, "uploads/" + name);
        if (fs.existsSync(dest))
          throw new HttpError(409, "同名文件已存在，请重命名后上传");
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data, { flag: "wx" });
        store.event(id, "files", { files: store.files(id) });
        return json(res, { path: "uploads/" + name, size: data.length }, 201);
      }
      if (action === "file" && req.method === "GET") {
        const relative = url.searchParams.get("path");
        const file = store.file(id, relative);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile())
          throw new HttpError(404, "文件不存在");
        const size = fs.statSync(file).size;
        if (url.searchParams.get("download") === "1") {
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": size,
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
          });
          return fs.createReadStream(file).pipe(res);
        }
        if (size > 512000)
          return json(res, {
            path: relative,
            content: "文件过大，请下载后查看。",
            size,
            truncated: true,
          });
        const data = fs.readFileSync(file);
        if (data.includes(0))
          return json(res, {
            path: relative,
            content: "此文件为二进制文件，请下载后查看。",
            size,
            truncated: true,
          });
        return json(res, {
          path: relative,
          content: data.toString("utf8"),
          size,
          truncated: false,
        });
      }
      if (action === "export" && req.method === "GET") {
        const format = url.searchParams.get("format") || "json";
        if (!["json", "markdown"].includes(format))
          throw new HttpError(400, "不支持的导出格式");
        if (format === "markdown") {
          const transcript =
            `# ${session.title}\n\n会话 ID：${session.id}\n\n` +
            session.messages
              .map(
                (message) =>
                  `## ${message.role === "user" ? "用户" : "助手"} · ${message.at}\n\n${message.content}\n`,
              )
              .join("\n");
          res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="session-${id}.md"`,
            "Cache-Control": "no-store",
          });
          return res.end(transcript);
        }
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="session-${id}.json"`,
        );
        return json(res, {
          session,
          events: store.events(id),
          files: store.files(id),
        });
      }
      if (action === "artifacts.zip" && req.method === "GET") {
        if (busy(session))
          throw new HttpError(
            409,
            "请等待任务结束后打包，避免获取到未完成的成果",
          );
        const workspaceFiles = store.files(id, { limit: 1001 });
        if (workspaceFiles.length > 1000)
          throw new HttpError(413, "会话文件数量超过 1000，请分别下载成果文件");
        const files = workspaceFiles.filter((file) =>
          file.path.startsWith("outputs/"),
        );
        if (!files.length)
          throw new HttpError(404, "当前会话还没有 outputs/ 成果文件");
        if (files.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024)
          throw new HttpError(413, "成果总大小超过 32 MB，请分别下载文件");
        const entries = [];
        let bytes = 0;
        for (const file of files) {
          const filename = store.file(id, file.path);
          const descriptor = fs.openSync(
            filename,
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
          );
          try {
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile() || stat.size !== file.size)
              throw new HttpError(409, "成果文件已变化，请刷新后重试");
            bytes += stat.size;
            if (bytes > 32 * 1024 * 1024)
              throw new HttpError(413, "成果总大小超过 32 MB，请分别下载文件");
            const data = Buffer.alloc(stat.size);
            let offset = 0;
            while (offset < data.length) {
              const read = fs.readSync(
                descriptor,
                data,
                offset,
                data.length - offset,
                offset,
              );
              if (!read)
                throw new HttpError(409, "成果文件已变化，请刷新后重试");
              offset += read;
            }
            const after = fs.fstatSync(descriptor);
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
              throw new HttpError(409, "成果文件已变化，请刷新后重试");
            entries.push({
              name: file.path,
              data,
              modifiedAt: stat.mtime.toISOString(),
            });
          } finally {
            fs.closeSync(descriptor);
          }
        }
        const archive = createZip(entries);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": archive.length,
          "Content-Disposition": `attachment; filename="artifacts-${id}.zip"`,
          "Cache-Control": "no-store",
        });
        return res.end(archive);
      }
    }
    if (route.startsWith("/api/") || route.startsWith("/internal/"))
      throw new HttpError(404, "接口不存在");
    if (req.method !== "GET" && req.method !== "HEAD")
      throw new HttpError(405, "Method not allowed");
    const name = route === "/" ? "index.html" : route.slice(1);
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new HttpError(404, "页面不存在");
    const file = path.join(project, "public", name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      throw new HttpError(404, "页面不存在");
    res.writeHead(200, {
      "Content-Type": mime[path.extname(file)] || "application/octet-stream",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    if (res.headersSent) return res.end();
    json(
      res,
      {
        error: runner.redact(
          error.status ? error.message : "服务暂时无法处理请求，请重试。",
        ),
      },
      error.status || 500,
    );
    if (!error.status) console.error(runner.redact(error.stack));
  }
});
server.listen(config.port, config.host, () =>
  console.log(
    `Workbench http://${config.host}:${config.port} | Codex ${runner.bin ? "ready" : "missing"} | ${config.protocol} adapter`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    runner.shutdown();
    server.close();
    setTimeout(() => process.exit(0), 3500).unref();
  });
