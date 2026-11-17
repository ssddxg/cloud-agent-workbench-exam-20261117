// Offline UI fixture uses previously captured application results. It never calls a model.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const target = path.resolve(
  process.env.BROWSER_DATA_DIR || path.join(project, "work", "browser-data"),
);
const snapshot = JSON.parse(
  await fs.readFile(
    path.join(project, "evidence/code-task/session.json"),
    "utf8",
  ),
);
const session = snapshot.session;
session.title = "功能验证 · 历史任务回放";
session.pinned = false;
session.archived = false;
const folder = path.join(target, "sessions", session.id);
await fs.mkdir(path.join(folder, "workspace"), { recursive: true });
await fs.cp(
  path.join(project, "evidence/code-task/outputs"),
  path.join(folder, "workspace/outputs"),
  { recursive: true },
);
await fs.writeFile(
  path.join(folder, "session.json"),
  JSON.stringify(session, null, 2),
);
await fs.writeFile(
  path.join(folder, "events.jsonl"),
  snapshot.events.map((event) => JSON.stringify(event)).join("\n") + "\n",
);
console.log(`Prepared offline browser fixture ${session.id}`);
