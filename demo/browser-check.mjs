// Browser QA runs only against our own localhost application in the Linux CI runner.
import fs from "node:fs/promises";
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
const base = process.env.DEMO_URL || "http://127.0.0.1:3210";
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1512, height: 982 },
  deviceScaleFactor: 1,
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await fs.mkdir("evidence/screenshots", { recursive: true });
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    document.querySelector("#connection").textContent.includes("Agent 已就绪"),
  );
  await page.locator("#new-session").click();
  await page.locator(".welcome h2").waitFor();
  await page.screenshot({
    path: "evidence/screenshots/01-workspace.png",
    fullPage: true,
  });
  page.once("dialog", (dialog) => dialog.accept("浏览器验证 · 材料工作"));
  await page.locator("#rename-session").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#session-title").textContent ===
      "浏览器验证 · 材料工作",
  );
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "# 材料验证\n文件上传、预览和会话恢复。\n<script>window.__untrusted=true</script>",
      ),
    });
  await page.locator(".file-info").filter({ hasText: "notes.md" }).waitFor();
  await page.locator(".file-info").filter({ hasText: "notes.md" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#preview-content").textContent.includes("文件上传"),
  );
  assert.equal(
    await page.evaluate(() => window.__untrusted),
    undefined,
    "Uploaded HTML/script must remain inert text",
  );
  await page.screenshot({
    path: "evidence/screenshots/02-material-preview.png",
    fullPage: true,
  });
  await page.locator("#close-preview").click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector("#session-title").textContent ===
      "浏览器验证 · 材料工作",
  );
  assert.equal(
    await page.locator("#session-title").textContent(),
    "浏览器验证 · 材料工作",
  );
  await page.locator(".file-info").filter({ hasText: "notes.md" }).waitFor();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载 notes.md", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "notes.md");
  const sessions = await (await fetch(base + "/api/sessions")).json();
  const material = sessions.find((s) => s.title === "浏览器验证 · 材料工作");
  assert.ok(material);
  const materialRow = () =>
    page.locator(`.session-row[data-session-id="${material.id}"]`);
  await materialRow().hover();
  await materialRow().locator('[data-action="pin"]').click();
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(
          `.session-row[data-session-id="${id}"] [data-action="pin"]`,
        )
        ?.getAttribute("aria-label") === "取消置顶",
    material.id,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector("#session-title").textContent ===
      "浏览器验证 · 材料工作",
  );
  assert.equal(
    await materialRow()
      .locator('[data-action="pin"]')
      .getAttribute("aria-label"),
    "取消置顶",
  );
  await page.locator("#session-search").fill("浏览器验证");
  assert.equal(await page.locator(".session-row").count(), 1);
  await page.locator("#session-search").fill("no-matching-session-729");
  assert.equal(await page.locator(".session-row").count(), 0);
  await page.locator("#session-search").fill("");
  await materialRow().hover();
  await materialRow().locator('[data-action="archive"]').click();
  await materialRow().waitFor({ state: "detached" });
  await page.locator("#scope-archived").click();
  await materialRow().locator(".session-item").click();
  await page.locator("#archive-banner").waitFor({ state: "visible" });
  assert.equal(await page.locator("#prompt").isDisabled(), true);
  await page.locator("#restore-session").click();
  await page.locator("#archive-banner").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#prompt").isDisabled(), false);
  await page.screenshot({
    path: "evidence/screenshots/06-session-organization.png",
    fullPage: true,
  });
  const fixture = sessions.find((s) => s.title === "功能验证 · 历史任务回放");
  assert.ok(fixture, "CI must load the documented offline fixture");
  await page
    .locator(".session-item")
    .filter({ hasText: fixture.title })
    .click();
  await page.waitForFunction(
    (title) => document.querySelector("#session-title").textContent === title,
    fixture.title,
  );
  await page.locator("#show-history").click();
  await page.locator("#history-dialog").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.querySelectorAll(".history-run").length === 2,
  );
  await page.locator(".history-run").last().click();
  await page.waitForFunction(() =>
    document
      .querySelector("#history-detail h3")
      .textContent.startsWith("第 1 次执行"),
  );
  assert.ok((await page.locator("#history-detail details").count()) > 0);
  const markdownPromise = page.waitForEvent("download");
  await page.locator("#history-export-markdown").click();
  const markdown = await markdownPromise;
  assert.ok(markdown.suggestedFilename().endsWith(".md"));
  assert.ok(
    (await fs.readFile(await markdown.path(), "utf8")).includes("费用汇总"),
  );
  await page.screenshot({
    path: "evidence/screenshots/07-execution-history.png",
    fullPage: true,
  });
  await page.locator("#close-history").click();
  await page.waitForFunction(
    () => !document.querySelector("#download-artifacts").disabled,
  );
  const zipPromise = page.waitForEvent("download");
  await page.locator("#download-artifacts").click();
  const zip = await zipPromise;
  const bytes = await fs.readFile(await zip.path());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.ok(bytes.includes(Buffer.from("outputs/expense-summary.mjs")));
  await page.screenshot({
    path: "evidence/screenshots/08-artifacts.png",
    fullPage: true,
  });
  const real = sessions.find(
    (s) =>
      s.title === "Docker real CLI verification" && s.status === "completed",
  );
  if (real) {
    await page.locator(".session-item").filter({ hasText: real.title }).click();
    await page.waitForFunction(
      (title) => document.querySelector("#session-title").textContent === title,
      real.title,
    );
    await page.locator(".file-info").filter({ hasText: "report.md" }).waitFor();
    await page.screenshot({
      path: "evidence/screenshots/03-real-cli-result.png",
      fullPage: true,
    });
    await page.locator(".file-info").filter({ hasText: "report.md" }).click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#preview-content")
          .textContent.includes("正在读取"),
    );
    await page.screenshot({
      path: "evidence/screenshots/04-report-preview.png",
      fullPage: true,
    });
    await page.locator("#close-preview").click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector("#sidebar").getBoundingClientRect().right <= 1,
  );
  await page.screenshot({
    path: "evidence/screenshots/05-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
    "Mobile layout must not overflow horizontally",
  );
  await page.locator("#menu-toggle").click();
  assert.ok(
    await page
      .locator("#sidebar")
      .evaluate((el) => el.classList.contains("open")),
  );
  assert.deepEqual(errors, [], "Browser must not raise JavaScript errors");
  const evidence = {
    generatedAt: new Date().toISOString(),
    browser: "Headless Google Chrome in GitHub Actions",
    environment:
      "Docker application; enhancement checks use an offline snapshot of previously verified tasks and do not call a model",
    checks: {
      render: true,
      newSession: true,
      rename: true,
      upload: true,
      safePreview: true,
      download: true,
      refreshRestore: true,
      multipleSessions: true,
      sessionSearch: true,
      pinPersistsAfterReload: true,
      archiveAndRestore: true,
      archiveIsReadOnly: true,
      executionHistory: true,
      markdownExport: true,
      artifactsZipDownload: true,
      mobileLayout: true,
      realCliResultVisible: !!real,
      offlineHistoryFixture: true,
      javaScriptErrors: errors,
    },
    screenshots: [
      "01-workspace.png",
      "02-material-preview.png",
      ...(real ? ["03-real-cli-result.png", "04-report-preview.png"] : []),
      "05-mobile.png",
      "06-session-organization.png",
      "07-execution-history.png",
      "08-artifacts.png",
    ],
  };
  await fs.writeFile(
    "evidence/browser-verification.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close();
}
