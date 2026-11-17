(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const icons = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    spark:
      '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z"/><path d="m20 2 .7 1.3L22 4l-1.3.7L20 6l-.7-1.3L18 4l1.3-.7L20 2Z"/>',
    code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20"/>',
    doc: '<path d="M14 2H5a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8l-6-6Z"/><path d="M14 2v6h6M8 12h8M8 16h6"/>',
    chat: '<path d="M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v9Z"/><path d="M8 8h8M8 12h5"/>',
    folder:
      '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/>',
    upload:
      '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
    download:
      '<path d="M12 3v13m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    paperclip:
      '<path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8a2 2 0 0 1 3 3l-8 8a1 1 0 0 0 2 2l7-7"/>',
    "arrow-up": '<path d="M12 19V5m-6 6 6-6 6 6"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2 7M20 4v7h-7"/>',
    shield:
      '<path d="m12 2 8 3v6c0 5-5 9-8 11-3-2-8-6-8-11V5l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    panel:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
    alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    pin: '<path d="m8 3 8 0-1 6 4 4v2h-6v7h-2v-7H5v-2l4-4-1-6Z"/>',
    archive: '<path d="M3 4h18v4H3zM5 8v12h14V8M9 12h6"/>',
    restore: '<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/>',
    package:
      '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5ZM3 7l9 5 9-5M12 12v10M7 4.8l10 5.5"/>',
  };
  function icon(name) {
    const span = document.createElement("span");
    span.className = "icon";
    span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.doc}</svg>`;
    return span;
  }
  document
    .querySelectorAll("[data-icon]")
    .forEach((el) => el.replaceChildren(icon(el.dataset.icon).firstChild));
  const state = {
    id: null,
    session: null,
    sessions: [],
    events: new Map(),
    source: null,
    selection: 0,
    loading: false,
    uploading: false,
    health: null,
    refreshTimer: null,
    toastTimer: null,
    draft: new Map(),
    scope: "active",
    files: [],
    historyRun: null,
    metadataPending: new Set(),
  };
  const busy = () =>
    ["running", "queued", "cancelling"].includes(state.session?.status);
  const archived = () => !!state.session?.archived;
  const labels = {
    idle: "待开始",
    running: "正在执行",
    queued: "排队中",
    cancelling: "正在停止",
    completed: "已完成",
    failed: "执行失败",
    cancelled: "已停止",
    interrupted: "执行已中断",
    timed_out: "执行超时",
  };
  function text(tag, value, className) {
    const el = document.createElement(tag);
    el.textContent = value;
    if (className) el.className = className;
    return el;
  }
  function toast(message, error = false) {
    clearTimeout(state.toastTimer);
    $("toast").textContent = message;
    $("toast").className = "toast" + (error ? " error" : "");
    $("toast").hidden = false;
    state.toastTimer = setTimeout(() => ($("toast").hidden = true), 4500);
  }
  async function api(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok)
      throw new Error(
        data?.error?.message ||
          data?.error ||
          data?.message ||
          `请求失败（${res.status}）`,
      );
    return data;
  }
  const endpoint = (suffix) =>
    `/api/sessions/${encodeURIComponent(state.id)}${suffix || ""}`;
  function formatTime(iso) {
    return iso
      ? new Date(iso).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : "";
  }
  function shortDate(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    return date.toDateString() === new Date().toDateString()
      ? "今天 " + formatTime(iso)
      : `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  }
  function size(n) {
    return n >= 1048576
      ? (n / 1048576).toFixed(1) + " MB"
      : n >= 1024
        ? (n / 1024).toFixed(1) + " KB"
        : n + " B";
  }
  function renderSessions() {
    const list = $("sessions");
    list.replaceChildren();
    $("session-count").textContent = state.sessions.filter(
      (s) => !s.archived,
    ).length;
    $("scope-active").classList.toggle("active", state.scope === "active");
    $("scope-archived").classList.toggle("active", state.scope === "archived");
    $("scope-active").setAttribute(
      "aria-pressed",
      String(state.scope === "active"),
    );
    $("scope-archived").setAttribute(
      "aria-pressed",
      String(state.scope === "archived"),
    );
    const query = $("session-search").value.trim().toLocaleLowerCase();
    const sessions = state.sessions
      .filter(
        (s) =>
          !!s.archived === (state.scope === "archived") &&
          (!query || s.title.toLocaleLowerCase().includes(query)),
      )
      .sort(
        (a, b) =>
          Number(!!b.pinned) - Number(!!a.pinned) ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
    if (!sessions.length)
      list.append(
        text(
          "div",
          query
            ? "没有找到匹配的工作。"
            : state.scope === "archived"
              ? "归档后的工作会保留在这里。"
              : "还没有工作。\n从一个想法开始吧。",
          "sidebar-empty",
        ),
      );
    for (const session of sessions) {
      const row = text("div", "", "session-row");
      row.dataset.sessionId = session.id;
      const button = document.createElement("button");
      const running = ["running", "queued", "cancelling"].includes(
        session.status,
      );
      button.className =
        "session-item" +
        (session.id === state.id ? " active" : "") +
        (running ? " busy" : "");
      button.setAttribute(
        "aria-current",
        session.id === state.id ? "page" : "false",
      );
      button.append(icon(session.pinned ? "pin" : "chat"));
      const copy = text("span", "", "session-copy");
      copy.append(text("strong", session.title));
      const small = text("small", "");
      small.append(
        text("span", "", "session-dot"),
        document.createTextNode(
          running ? labels[session.status] : shortDate(session.updatedAt),
        ),
      );
      copy.append(small);
      button.append(copy);
      button.onclick = () => selectSession(session.id);
      const actions = text("div", "", "session-actions");
      for (const action of [
        {
          name: "pin",
          label: session.pinned ? "取消置顶" : "置顶工作",
          icon: "pin",
          update: { pinned: !session.pinned },
        },
        {
          name: "archive",
          label: session.archived ? "恢复工作" : "归档工作",
          icon: session.archived ? "restore" : "archive",
          update: { archived: !session.archived },
        },
      ]) {
        const control = text(
          "button",
          "",
          "session-action" +
            (action.name === "pin" && session.pinned ? " selected" : ""),
        );
        control.type = "button";
        control.dataset.action = action.name;
        control.title = action.label;
        control.setAttribute("aria-label", action.label + "：" + session.title);
        control.disabled =
          state.metadataPending.has(session.id) ||
          (action.name === "archive" && running);
        control.append(icon(action.icon));
        control.onclick = () =>
          updateSessionMetadata(session.id, action.update);
        actions.append(control);
      }
      row.append(button, actions);
      list.append(row);
    }
  }
  async function updateSessionMetadata(id, update) {
    if (state.metadataPending.has(id)) return;
    state.metadataPending.add(id);
    renderSessions();
    const selection = state.selection;
    try {
      const session = await api(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(update),
      });
      await refreshSessions();
      if (state.id === id && state.selection === selection) {
        if (update.archived === true) {
          const next = state.sessions
            .filter((s) => !s.archived)
            .sort(
              (a, b) =>
                Number(!!b.pinned) - Number(!!a.pinned) ||
                b.updatedAt.localeCompare(a.updatedAt),
            )[0];
          state.scope = "active";
          if (next) await selectSession(next.id);
          else clearSelection();
        } else {
          state.session = session;
          if (update.archived === false) state.scope = "active";
          renderSessions();
          renderConversation();
        }
      }
      toast(
        update.archived === true
          ? "工作已归档，消息和成果仍会保留。"
          : update.archived === false
            ? "工作已恢复，可以继续交流。"
            : update.pinned
              ? "工作已置顶。"
              : "已取消置顶。",
      );
    } catch (error) {
      toast(error.message, true);
    } finally {
      state.metadataPending.delete(id);
      renderSessions();
    }
  }
  function clearSelection() {
    if (state.id) state.draft.set(state.id, $("prompt").value);
    state.source?.close();
    state.source = null;
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    state.id = null;
    state.session = null;
    state.events.clear();
    state.selection++;
    $("prompt").value = "";
    try {
      localStorage.removeItem("cloud-agent-session");
    } catch {}
    $("history-dialog").close();
    $("preview-dialog").close();
    renderSessions();
    renderConversation();
    renderFiles([]);
    resizePrompt();
  }
  async function refreshSessions() {
    const list = await api("/api/sessions");
    state.sessions = Array.isArray(list) ? list : list.sessions || [];
    renderSessions();
  }
  function inlineMarkdown(container, value) {
    const expression =
      /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
    let cursor = 0;
    for (const match of value.matchAll(expression)) {
      container.append(
        document.createTextNode(value.slice(cursor, match.index)),
      );
      const token = match[0];
      if (token.startsWith("`"))
        container.append(text("code", token.slice(1, -1)));
      else if (token.startsWith("**"))
        container.append(text("strong", token.slice(2, -2)));
      else {
        const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
        const anchor = text("a", link[1]);
        anchor.href = link[2];
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        container.append(anchor);
      }
      cursor = match.index + token.length;
    }
    container.append(document.createTextNode(value.slice(cursor)));
  }
  function markdownBlocks(container, value) {
    const lines = value.replaceAll("\r", "").split("\n");
    for (let i = 0; i < lines.length; ) {
      if (!lines[i].trim()) {
        i++;
        continue;
      }
      if (
        /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || "") &&
        lines[i].includes("|")
      ) {
        const wrap = text("div", "", "table-wrap");
        const table = document.createElement("table");
        const head = document.createElement("thead");
        const body = document.createElement("tbody");
        const row = (line, cellTag) => {
          const tr = document.createElement("tr");
          for (const cell of line
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")) {
            const td = document.createElement(cellTag);
            inlineMarkdown(td, cell.trim());
            tr.append(td);
          }
          return tr;
        };
        head.append(row(lines[i], "th"));
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          body.append(row(lines[i], "td"));
          i++;
        }
        table.append(head, body);
        wrap.append(table);
        container.append(wrap);
        continue;
      }
      const heading = lines[i].match(/^(#{1,6})\s+(.+)/);
      if (heading) {
        const h = document.createElement(
          "h" + Math.min(6, heading[1].length + 2),
        );
        inlineMarkdown(h, heading[2]);
        container.append(h);
        i++;
        continue;
      }
      if (/^\s*[-*_]{3,}\s*$/.test(lines[i])) {
        container.append(document.createElement("hr"));
        i++;
        continue;
      }
      const listMatch = lines[i].match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)/);
      if (listMatch) {
        const list = document.createElement(listMatch[2] ? "ol" : "ul");
        while (i < lines.length) {
          const match = lines[i].match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)/);
          if (!match) break;
          const li = document.createElement("li");
          inlineMarkdown(li, match[3]);
          list.append(li);
          i++;
        }
        container.append(list);
        continue;
      }
      const paragraph = document.createElement("p");
      const parts = [];
      while (i < lines.length && lines[i].trim()) {
        if (
          parts.length &&
          (/^#{1,6}\s|^\s*(?:[-*+] |\d+\. )/.test(lines[i]) ||
            (/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || "") &&
              lines[i].includes("|")))
        )
          break;
        parts.push(lines[i]);
        i++;
      }
      inlineMarkdown(paragraph, parts.join("\n"));
      container.append(paragraph);
    }
  }
  function safeRichText(container, content) {
    const parts = String(content || "").split(
      /```([^\n]*)\n([\s\S]*?)(?:```|$)/g,
    );
    for (let i = 0; i < parts.length; i += 3) {
      if (parts[i]) markdownBlocks(container, parts[i]);
      if (parts[i + 2] !== undefined) {
        const pre = text("pre", "");
        if (parts[i + 1].trim())
          pre.append(text("span", parts[i + 1].trim(), "code-label"));
        pre.append(document.createTextNode(parts[i + 2]));
        container.append(pre);
      }
    }
  }
  const starters = [
    {
      icon: "code",
      title: "开发一个小工具",
      desc: "从想法到代码，一起把它做出来",
      prompt:
        "请帮我开发一个可以直接打开使用的番茄钟网页工具，包含开始、暂停和重置功能，生成 HTML、CSS、JavaScript 文件，并验证功能。",
    },
    {
      icon: "doc",
      title: "分析材料与整理报告",
      desc: "上传工作材料，提炼重点与行动项",
      prompt:
        "请分析我上传的工作材料，整理关键发现、风险和下一步行动，生成一份结构清晰的 Markdown 报告。",
    },
  ];
  function renderWelcome() {
    const section = text("section", "", "welcome");
    const emblem = text("div", "", "welcome-emblem");
    emblem.append(icon("spark"));
    section.append(
      emblem,
      text("span", "YOUR IDEAS, IN MOTION", "eyebrow"),
      text("h2", "把想法，交给行动。"),
      text(
        "p",
        "写代码、分析材料、整理报告。\n给助手一项任务，让工作从这里向前。",
      ),
    );
    const grid = text("div", "", "starter-grid");
    for (const item of starters) {
      const button = text("button", "", "starter");
      button.append(
        icon(item.icon),
        text("strong", item.title),
        text("small", item.desc),
        text("span", "↗", "starter-arrow"),
      );
      button.onclick = () => {
        $("prompt").value = item.prompt;
        resizePrompt();
        $("prompt").focus();
      };
      grid.append(button);
    }
    section.append(grid);
    const foot = text("div", "", "welcome-footer");
    for (const [name, label] of [
      ["chat", "多会话协作"],
      ["folder", "成果随时获取"],
      ["clock", "随时回来继续"],
    ]) {
      const item = text("span", "");
      item.append(icon(name), document.createTextNode(label));
      foot.append(item);
    }
    section.append(foot);
    return section;
  }
  function renderConversation() {
    const scroll = $("chat-scroll");
    const nearBottom =
      scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180;
    const container = $("chat-content");
    container.replaceChildren();
    const messages = state.session?.messages || [];
    if (!messages.length) container.append(renderWelcome());
    for (const message of messages) {
      const article = text(
        "article",
        "",
        `message ${message.role === "user" ? "user" : "assistant"}`,
      );
      const header = text("div", "", "message-header");
      const avatar = text("span", "", "message-avatar");
      if (message.role === "user") avatar.textContent = "我";
      else avatar.append(icon("spark"));
      header.append(
        avatar,
        text("strong", message.role === "user" ? "你" : "云栖助手"),
        text("time", formatTime(message.at || message.createdAt)),
      );
      const body = text("div", "", "message-body");
      safeRichText(body, message.content);
      article.append(header, body);
      container.append(article);
    }
    if (busy()) {
      const thinking = text("div", "", "thinking");
      thinking.append(
        document.createElement("i"),
        document.createElement("i"),
        document.createElement("i"),
        text(
          "span",
          state.session.status === "queued"
            ? "任务已排队，稍后开始"
            : state.session.status === "cancelling"
              ? "正在停止执行…"
              : "助手正在推进工作…",
        ),
      );
      container.append(thinking);
    }
    if (state.session?.error) {
      const alert = text("div", "", "run-banner error");
      alert.append(icon("alert"), text("span", state.session.error));
      container.append(alert);
    }
    $("session-title").textContent = state.session?.title || "新的开始";
    $("rename-session").hidden = !state.id;
    $("export-session").disabled = !state.id;
    $("show-history").disabled = !state.id || !state.session?.runs?.length;
    $("archive-banner").hidden = !archived();
    $("restore-session").disabled = state.metadataPending.has(state.id);
    $("stop-run").hidden = !busy();
    $("stop-run").disabled = state.session?.status === "cancelling";
    syncControls();
    renderTraces();
    if ($("history-dialog").open) renderHistory();
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }
  function eventItem(e) {
    const event = e.event || e.data?.event || e.data || e;
    return event.item || event;
  }
  function renderTraces() {
    const status = state.session?.status || "idle";
    $("run-indicator").textContent = labels[status] || status;
    $("run-indicator").className = "run-indicator" + (busy() ? " busy" : "");
    const summary = $("run-summary");
    const run = state.session?.runs?.at(-1);
    if (run) {
      const duration =
        run.finishedAt && run.startedAt
          ? Math.max(
              1,
              Math.round(
                (new Date(run.finishedAt) - new Date(run.startedAt)) / 1000,
              ),
            )
          : null;
      summary.replaceChildren(
        icon(busy() ? "terminal" : status === "failed" ? "alert" : "check"),
      );
      const p = text("p", "");
      p.append(
        text("strong", labels[status] || status),
        document.createTextNode(
          `${formatTime(run.startedAt)} 开始${duration ? " · 用时 " + duration + " 秒" : ""}`,
        ),
      );
      summary.append(p);
    } else {
      summary.replaceChildren(
        icon("spark"),
        text("p", "交给助手一项任务，\n这里将显示它的行动过程。"),
      );
    }
    const list = $("run-traces");
    const open = new Set(
      [...list.querySelectorAll("details[open]")].map((x) => x.dataset.key),
    );
    list.replaceChildren();
    const items = [...state.events.values()].filter(
      (e) => e.type === "agent" || e.type === "error",
    );
    const meaningful = items
      .filter((e) => {
        const item = eventItem(e);
        return (
          [
            "command_execution",
            "file_change",
            "error",
            "mcp_tool_call",
            "web_search",
            "todo_list",
          ].includes(item.type) || e.type === "error"
        );
      })
      .slice(-12);
    for (const e of meaningful.reverse()) {
      const item = eventItem(e);
      const details = text("details", "", "trace");
      details.dataset.key = e.id;
      details.open = open.has(e.id);
      let title = item.command || item.message || item.type || "执行步骤";
      if (item.type === "file_change")
        title =
          "文件已更新 · " + (item.changes || []).map((c) => c.path).join("、");
      if (item.type === "todo_list") title = "任务计划";
      title = String(title);
      const heading = title.length > 72 ? title.slice(0, 72) + "…" : title;
      details.append(
        text("summary", heading),
        text("div", formatTime(e.at), "trace-time"),
      );
      const output =
        item.aggregated_output ||
        item.output ||
        item.message ||
        (item.changes ? JSON.stringify(item.changes, null, 2) : title);
      details.append(
        text(
          "pre",
          typeof output === "string"
            ? output.slice(-14000)
            : JSON.stringify(output, null, 2),
        ),
      );
      list.append(details);
    }
  }
  async function refreshSelected(selection = state.selection) {
    const id = state.id;
    if (!id) return;
    const session = await api(`/api/sessions/${encodeURIComponent(id)}`);
    if (selection !== state.selection || id !== state.id) return;
    state.session = session;
    renderConversation();
    await refreshFiles(selection);
  }
  function scheduleRefresh() {
    if (state.refreshTimer) return;
    const token = state.selection;
    state.refreshTimer = setTimeout(async () => {
      state.refreshTimer = null;
      try {
        await refreshSelected(token);
        await refreshSessions();
      } catch (error) {
        toast(error.message, true);
      }
    }, 350);
  }
  async function selectSession(id) {
    if (state.id) state.draft.set(state.id, $("prompt").value);
    state.source?.close();
    state.source = null;
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    state.id = id;
    state.session = null;
    state.historyRun = null;
    state.scope = state.sessions.find((s) => s.id === id)?.archived
      ? "archived"
      : "active";
    $("history-dialog").close();
    $("preview-dialog").close();
    state.events.clear();
    const token = ++state.selection;
    try {
      localStorage.setItem("cloud-agent-session", id);
    } catch {}
    $("prompt").value = state.draft.get(id) || "";
    resizePrompt();
    $("sidebar").classList.remove("open");
    renderSessions();
    renderConversation();
    renderFiles([]);
    try {
      const [session, events] = await Promise.all([
        api(`/api/sessions/${encodeURIComponent(id)}`),
        api(`/api/sessions/${encodeURIComponent(id)}/events`),
      ]);
      if (token !== state.selection) return;
      state.session = session;
      state.scope = session.archived ? "archived" : "active";
      renderSessions();
      for (const e of Array.isArray(events) ? events : events.events || [])
        state.events.set(e.id, e);
      renderConversation();
      $("chat-scroll").scrollTop = $("chat-scroll").scrollHeight;
      await refreshFiles(token);
      if (token !== state.selection) return;
      const source = new EventSource(
        `/api/sessions/${encodeURIComponent(id)}/stream`,
      );
      state.source = source;
      source.onmessage = (event) => {
        if (token !== state.selection) return;
        try {
          const e = JSON.parse(event.data);
          state.events.set(e.id, e);
          if (state.events.size > 1000)
            state.events.delete(state.events.keys().next().value);
          if (e.type === "agent") renderTraces();
          scheduleRefresh();
        } catch {}
      };
      source.addEventListener("status", (event) => {
        try {
          const e = JSON.parse(event.data);
          state.events.set(e.id, e);
          scheduleRefresh();
        } catch {}
      });
      source.onerror = () => {
        if (token === state.selection) scheduleRefresh();
      };
    } catch (error) {
      if (token === state.selection) toast(error.message, true);
    }
  }
  async function refreshFiles(token = state.selection) {
    if (!state.id) {
      renderFiles([]);
      return;
    }
    const id = state.id;
    const result = await api(`/api/sessions/${encodeURIComponent(id)}/files`);
    if (token !== state.selection || id !== state.id) return;
    renderFiles(Array.isArray(result) ? result : result.files || []);
  }
  function fileUrl(file, download = false) {
    return (
      endpoint("/file") +
      "?path=" +
      encodeURIComponent(file) +
      (download ? "&download=1" : "")
    );
  }
  function renderFiles(files) {
    state.files = files;
    syncArtifactDownload();
    $("file-count").textContent = files.length;
    const list = $("files");
    list.replaceChildren();
    if (!files.length)
      list.append(
        text("p", "还没有文件，上传材料或让助手生成成果。", "file-empty"),
      );
    for (const file of files) {
      const card = text("div", "", "file-card");
      const filename = file.path.split("/").at(-1);
      const extension = filename.includes(".")
        ? filename.split(".").at(-1).slice(0, 4)
        : "file";
      const isCode = /^(html|css|js|ts|py|json|jsx|tsx|sh|sql)$/.test(
        extension,
      );
      const badge = text(
        "span",
        extension,
        "file-symbol " +
          (isCode
            ? "code"
            : /^(md|txt|csv|docx|pdf)$/.test(extension)
              ? "doc"
              : ""),
      );
      const button = text("button", "", "file-info");
      button.title = file.path;
      button.append(
        text("strong", filename),
        text(
          "small",
          `${size(file.size)} · ${file.path.includes("/") ? file.path.substring(0, file.path.lastIndexOf("/")) : "工作目录"}`,
        ),
      );
      button.onclick = () => previewFile(file);
      const download = document.createElement("a");
      download.href = fileUrl(file.path, true);
      download.download = filename;
      download.title = "下载 " + filename;
      download.setAttribute("aria-label", "下载 " + filename);
      download.append(icon("download"));
      card.append(badge, button, download);
      list.append(card);
    }
  }
  async function previewFile(file) {
    const id = state.id;
    $("preview-name").textContent = file.path;
    $("preview-content").textContent = "正在读取文件…";
    $("preview-download").href = fileUrl(file.path, true);
    $("preview-download").download = file.path.split("/").at(-1);
    $("preview-dialog").showModal();
    try {
      const result = await api(
        `/api/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(file.path)}`,
      );
      $("preview-content").textContent =
        result.content ?? result.text ?? "此文件无法以文本预览，请下载查看。";
      if (result.truncated)
        $("preview-content").textContent +=
          "\n\n—— 预览已截断，请下载完整文件 ——";
    } catch (error) {
      $("preview-content").textContent =
        error.message + "\n可点击右上角下载原文件。";
    }
  }
  async function newSession(title) {
    state.scope = "active";
    $("session-search").value = "";
    const session = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: title || "新的工作" }),
    });
    await refreshSessions();
    await selectSession(session.id);
    return session;
  }
  function syncControls() {
    $("send").hidden = busy();
    $("send").disabled = archived() || state.loading || state.uploading;
    $("prompt").disabled = archived();
    $("prompt").placeholder = archived()
      ? "此工作已归档，恢复后可以继续交流。"
      : "告诉我你想完成什么，或上传文件开始工作…";
    $("upload-button").disabled =
      archived() || busy() || state.uploading || state.loading;
    $("upload-zone").disabled =
      archived() || busy() || state.uploading || state.loading;
    syncArtifactDownload();
  }
  function syncArtifactDownload() {
    $("download-artifacts").disabled =
      !state.id ||
      busy() ||
      !state.files.some((file) => file.path.startsWith("outputs/"));
  }
  async function downloadArtifacts() {
    const id = state.id;
    if (!id || busy()) return;
    $("download-artifacts").disabled = true;
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(id)}/artifacts.zip`,
      );
      if (!response.ok) {
        let error;
        try {
          error = await response.json();
        } catch {}
        throw new Error(error?.error || "成果打包失败，请重试。");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `artifacts-${id.slice(0, 8)}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast(error.message, true);
    } finally {
      if (state.id === id) syncArtifactDownload();
    }
  }
  function dateTime(iso) {
    return iso
      ? new Date(iso).toLocaleString("zh-CN", { hour12: false })
      : "尚未开始";
  }
  function runDuration(run) {
    if (!run.startedAt) return "等待执行";
    const seconds = Math.max(
      0,
      Math.round(
        (new Date(run.finishedAt || Date.now()) - new Date(run.startedAt)) /
          1000,
      ),
    );
    return seconds >= 60
      ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
      : `${seconds} 秒`;
  }
  function renderHistory() {
    const runs = state.session?.runs || [];
    const nav = $("history-runs"),
      detail = $("history-detail");
    const open = new Set(
      [...detail.querySelectorAll("details[open]")].map((el) => el.dataset.key),
    );
    nav.replaceChildren();
    detail.replaceChildren();
    if (!runs.length) {
      detail.append(text("p", "此工作还没有执行记录。", "history-empty"));
      return;
    }
    if (!runs.some((run) => run.id === state.historyRun))
      state.historyRun = runs.at(-1).id;
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i],
        button = text(
          "button",
          "",
          "history-run" + (run.id === state.historyRun ? " active" : ""),
        );
      button.dataset.runId = run.id;
      button.setAttribute("aria-pressed", String(run.id === state.historyRun));
      button.append(
        text("strong", `第 ${i + 1} 次执行`),
        text("span", labels[run.status] || run.status, "history-status"),
        text(
          "small",
          `${dateTime(run.startedAt || run.queuedAt)} · ${runDuration(run)}`,
        ),
      );
      button.onclick = () => {
        state.historyRun = run.id;
        renderHistory();
      };
      nav.append(button);
    }
    const run = runs.find((r) => r.id === state.historyRun);
    detail.append(
      text(
        "h3",
        `第 ${runs.indexOf(run) + 1} 次执行 · ${labels[run.status] || run.status}`,
      ),
      text(
        "p",
        `${dateTime(run.startedAt || run.queuedAt)} · ${runDuration(run)}`,
        "history-meta",
      ),
    );
    if (run.summary) detail.append(text("p", run.summary, "history-summary"));
    if (run.usage) {
      const usage = text("div", "", "history-usage");
      usage.append(text("strong", "CLI 报告用量"));
      const values = [
        ["输入", run.usage.input_tokens],
        ["输出", run.usage.output_tokens],
        ["缓存输入", run.usage.cached_input_tokens],
      ];
      for (const [label, value] of values)
        if (Number.isFinite(value))
          usage.append(
            text("span", `${label} ${value.toLocaleString("zh-CN")} tokens`),
          );
      detail.append(
        usage,
        text(
          "p",
          "用量由 CLI 返回，用于复查执行，不作为计费账单。",
          "history-note",
        ),
      );
    }
    const events = [...state.events.values()].filter(
      (e) => e.runId === run.id && e.type === "agent",
    );
    const items = new Map();
    for (const e of events) {
      const item = eventItem(e);
      if (
        [
          "command_execution",
          "file_change",
          "mcp_tool_call",
          "web_search",
          "error",
        ].includes(item.type)
      )
        items.set(item.id || e.id, { event: e, item });
    }
    if (!items.size)
      detail.append(text("p", "本次执行没有工具记录。", "history-empty"));
    for (const { event: e, item } of items.values()) {
      const title =
        item.type === "file_change"
          ? "文件更新 · " + (item.changes || []).map((c) => c.path).join("、")
          : item.command || item.message || item.type;
      const trace = text("details", "", "history-trace");
      trace.dataset.key = e.id;
      trace.open = open.has(e.id);
      trace.append(
        text("summary", String(title)),
        text(
          "small",
          `${formatTime(e.at)}${item.exit_code !== undefined && item.exit_code !== null ? " · 退出码 " + item.exit_code : ""}`,
        ),
      );
      const output =
        item.aggregated_output ||
        item.output ||
        item.message ||
        (item.changes ? JSON.stringify(item.changes, null, 2) : "");
      trace.append(
        text(
          "pre",
          typeof output === "string"
            ? output.slice(-30000)
            : JSON.stringify(output, null, 2),
        ),
      );
      detail.append(trace);
    }
  }
  async function openHistory() {
    const id = state.id,
      selection = state.selection;
    if (!id) return;
    state.historyRun = null;
    renderHistory();
    $("history-dialog").showModal();
    try {
      const [session, events] = await Promise.all([
        api(`/api/sessions/${encodeURIComponent(id)}`),
        api(`/api/sessions/${encodeURIComponent(id)}/events`),
      ]);
      if (
        state.id !== id ||
        state.selection !== selection ||
        !$("history-dialog").open
      )
        return;
      state.session = session;
      for (const e of events)
        if (!state.events.has(e.id)) state.events.set(e.id, e);
      renderHistory();
    } catch (error) {
      if (state.id === id && state.selection === selection)
        toast(error.message, true);
    }
  }
  // Capture the destination before the first await. Navigation must never redirect
  // an in-flight message or the remaining files in a batch to another workspace.
  async function createOperationSession(title, sourceId, sourceSelection) {
    state.scope = "active";
    $("session-search").value = "";
    const session = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    let selection = -1;
    if (state.id === sourceId && state.selection === sourceSelection) {
      const visibleDraft = $("prompt").value;
      const expectedSelection = state.selection + 1;
      await selectSession(session.id);
      if (state.id === session.id && state.selection === expectedSelection) {
        selection = state.selection;
        $("prompt").value = visibleDraft;
        resizePrompt();
      }
    }
    return { id: session.id, selection };
  }
  async function sendMessage(event) {
    event.preventDefault();
    const originalDraft = $("prompt").value;
    const content = originalDraft.trim();
    if (!content || archived() || busy() || state.loading || state.uploading)
      return;
    const sourceId = state.id;
    const sourceSelection = state.selection;
    const sourceSession = state.session;
    let targetId = sourceId;
    let targetSelection = sourceSelection;
    state.loading = true;
    syncControls();
    try {
      if (!targetId) {
        const target = await createOperationSession(
          content.slice(0, 22),
          sourceId,
          sourceSelection,
        );
        targetId = target.id;
        targetSelection = target.selection;
      } else if (
        !sourceSession?.messages?.length &&
        sourceSession?.title === "新的工作"
      ) {
        await api(`/api/sessions/${encodeURIComponent(targetId)}`, {
          method: "PATCH",
          body: JSON.stringify({ title: content.slice(0, 22) }),
        });
      }
      await api(`/api/sessions/${encodeURIComponent(targetId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      if (state.draft.get(targetId) === originalDraft)
        state.draft.delete(targetId);
      if (state.id === targetId && state.selection === targetSelection) {
        if ($("prompt").value === originalDraft) $("prompt").value = "";
        resizePrompt();
        await refreshSelected(targetSelection);
        if (state.id === targetId && state.selection === targetSelection) {
          $("chat-scroll").scrollTop = $("chat-scroll").scrollHeight;
        }
      }
      await refreshSessions();
    } catch (error) {
      // A failed request leaves the originating draft intact, including when
      // the user has navigated elsewhere while the request was pending.
      if (targetId && !state.draft.has(targetId))
        state.draft.set(targetId, originalDraft);
      if (
        state.id === targetId &&
        state.selection === targetSelection &&
        !$("prompt").value
      ) {
        $("prompt").value = originalDraft;
        resizePrompt();
      }
      toast(error.message, true);
    } finally {
      state.loading = false;
      syncControls();
      if (state.id === targetId && state.selection === targetSelection)
        $("prompt").focus();
    }
  }
  async function uploadFiles(fileList) {
    const files = [...fileList];
    if (!files.length || state.uploading || state.loading) return;
    if (archived()) return toast("请先恢复此工作，再添加材料。", true);
    if (busy()) return toast("请等待当前执行结束后再添加材料。", true);
    if (files.some((file) => file.size > 10_000_000))
      return toast("单个文件不能超过 10 MB。", true);
    const sourceId = state.id;
    const sourceSelection = state.selection;
    let targetId = sourceId;
    let targetSelection = sourceSelection;
    state.uploading = true;
    syncControls();
    $("upload-progress").hidden = false;
    try {
      if (!targetId) {
        const target = await createOperationSession(
          "材料分析",
          sourceId,
          sourceSelection,
        );
        targetId = target.id;
        targetSelection = target.selection;
      }
      for (let i = 0; i < files.length; i++) {
        $("upload-progress").textContent =
          `正在上传 ${i + 1}/${files.length}：${files[i].name}`;
        const contentBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () => reject(new Error("文件读取失败"));
          reader.readAsDataURL(files[i]);
        });
        await api(`/api/sessions/${encodeURIComponent(targetId)}/files`, {
          method: "POST",
          body: JSON.stringify({ name: files[i].name, contentBase64 }),
        });
      }
      if (state.id === targetId && state.selection === targetSelection) {
        await refreshFiles(targetSelection);
        $("prompt").focus();
      }
      await refreshSessions();
      toast(`已添加 ${files.length} 个文件，可以告诉助手如何处理。`);
    } catch (error) {
      toast(error.message, true);
    } finally {
      state.uploading = false;
      $("upload-progress").hidden = true;
      $("file-input").value = "";
      syncControls();
    }
  }
  async function refreshHealth() {
    try {
      const health = await api("/api/health");
      state.health = health;
      const ready = health.configured && health.cliAvailable !== false;
      $("connection").className = "connection" + (ready ? "" : " offline");
      $("connection").lastElementChild.textContent = ready
        ? "Agent 已就绪"
        : "等待配置";
      const message = !health.configured
        ? "Agent API 尚未配置。请在服务端 .env 中设置 API 地址、模型和凭据后重启。"
        : health.cliAvailable === false
          ? "未找到 Codex CLI，请按 README 配置 CODEX_BIN 或使用 Docker 启动。"
          : "";
      $("config-banner").hidden = !message;
      $("config-banner").textContent = message;
    } catch {
      $("connection").className = "connection offline";
      $("connection").lastElementChild.textContent = "连接已断开";
      $("config-banner").hidden = false;
      $("config-banner").textContent =
        "暂时无法连接工作台服务，正在自动重连。已保存的对话和文件仍会保留。";
    }
  }
  function resizePrompt() {
    $("prompt").style.height = "auto";
    $("prompt").style.height =
      Math.min(160, Math.max(48, $("prompt").scrollHeight)) + "px";
  }
  $("composer").onsubmit = sendMessage;
  $("session-search").addEventListener("input", renderSessions);
  $("scope-active").onclick = () => {
    state.scope = "active";
    renderSessions();
  };
  $("scope-archived").onclick = () => {
    state.scope = "archived";
    renderSessions();
  };
  $("restore-session").onclick = () => {
    if (state.id) updateSessionMetadata(state.id, { archived: false });
  };
  $("download-artifacts").onclick = downloadArtifacts;
  $("show-history").onclick = openHistory;
  $("history-export-markdown").onclick = () => {
    if (!state.id) return;
    const link = document.createElement("a");
    link.href = endpoint("/export") + "?format=markdown";
    link.download = `session-${state.id}.md`;
    link.click();
  };
  $("close-history").onclick = () => $("history-dialog").close();
  $("history-dialog").onclick = (event) => {
    if (event.target === $("history-dialog")) $("history-dialog").close();
  };
  $("prompt").addEventListener("input", resizePrompt);
  $("prompt").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage(event);
    }
  });
  $("new-session").onclick = async () => {
    try {
      await newSession();
      $("prompt").focus();
    } catch (error) {
      toast(error.message, true);
    }
  };
  $("rename-session").onclick = async () => {
    if (!state.id) return;
    const title = window.prompt(
      "给这项工作起个名字",
      state.session?.title || "",
    );
    if (!title?.trim()) return;
    try {
      await api(endpoint(), {
        method: "PATCH",
        body: JSON.stringify({ title: title.trim() }),
      });
      await refreshSelected();
      await refreshSessions();
    } catch (error) {
      toast(error.message, true);
    }
  };
  $("export-session").onclick = () => {
    if (state.id) {
      const a = document.createElement("a");
      a.href = endpoint("/export");
      a.download = "session.json";
      a.click();
    }
  };
  $("stop-run").onclick = async () => {
    try {
      await api(endpoint("/cancel"), { method: "POST", body: "{}" });
      await refreshSelected();
      toast("已请求停止，正在保留当前成果。");
    } catch (error) {
      toast(error.message, true);
    }
  };
  $("upload-button").onclick = $("upload-zone").onclick = () =>
    $("file-input").click();
  $("file-input").onchange = () => uploadFiles($("file-input").files);
  $("refresh-files").onclick = () =>
    refreshFiles().catch((error) => toast(error.message, true));
  $("files-toggle").onclick = () => $("artifacts").classList.toggle("open");
  $("menu-toggle").onclick = () => $("sidebar").classList.toggle("open");
  $("close-preview").onclick = () => $("preview-dialog").close();
  $("preview-dialog").onclick = (event) => {
    if (event.target === $("preview-dialog")) $("preview-dialog").close();
  };
  $("upload-zone").addEventListener("dragover", (event) => {
    event.preventDefault();
    $("upload-zone").classList.add("dragging");
  });
  $("upload-zone").addEventListener("dragleave", () =>
    $("upload-zone").classList.remove("dragging"),
  );
  $("upload-zone").addEventListener("drop", (event) => {
    event.preventDefault();
    $("upload-zone").classList.remove("dragging");
    uploadFiles(event.dataTransfer.files);
  });
  document.addEventListener("dragover", (event) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
  document.addEventListener("drop", (event) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
  renderConversation();
  renderFiles([]);
  (async () => {
    await refreshHealth();
    try {
      await refreshSessions();
      let last;
      try {
        last = localStorage.getItem("cloud-agent-session");
      } catch {}
      if (last && state.sessions.some((s) => s.id === last))
        await selectSession(last);
      else {
        const first = state.sessions.find((session) => !session.archived);
        if (first) await selectSession(first.id);
      }
    } catch (error) {
      toast(error.message, true);
    }
  })();
  setInterval(async () => {
    await refreshHealth();
    try {
      await refreshSessions();
      if (state.id && (busy() || state.source?.readyState !== EventSource.OPEN))
        await refreshSelected();
    } catch {}
  }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshHealth();
      refreshSessions().catch(() => {});
      if (state.id) refreshSelected().catch(() => {});
    }
  });
})();
