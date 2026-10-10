const LIVE_STATUSES = new Set(["pending", "running"]);
const INLINE_MEDIA_TYPES = {
  image: new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]),
  video: new Set(["video/mp4", "video/webm", "video/ogg"]),
  audio: new Set(["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg", "audio/flac"]),
};
const STATUSES = {
  generation: new Set(["pending", "running", "completed", "failed"]),
  publication: new Set(["published", "disabled"]),
};
const LABELS = {
  pending: "排队中",
  running: "正在生成",
  completed: "已生成",
  failed: "生成失败",
  published: "已发布",
  disabled: "已停用",
};
const ARROW = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 12 12 4M4.5 4H12v7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Cohub 返回的 ${field} 缺失或格式不正确。`);
  }
  return value;
}

function optionalString(value, field) {
  return value === undefined ? undefined : requiredString(value, field);
}

function httpUrl(value, field) {
  requiredString(value, field);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Cohub 返回的 ${field} 不是有效地址。`);
  }
  if (!new Set(["https:", "http:"]).has(url.protocol)) {
    throw new Error(`Cohub 返回的 ${field} 使用了不支持的地址格式。`);
  }
  return value;
}

function mediaUrl(item) {
  requiredString(item.url, "素材地址");
  if (!item.url.startsWith("data:")) return httpUrl(item.url, "素材地址");
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.url);
  if (!match || match[0] !== item.url || !INLINE_MEDIA_TYPES[item.type].has(match[1])) {
    throw new Error("Cohub 返回的内嵌素材格式不受支持。");
  }
  const [, mimeType, data] = match;
  if (item.mimeType !== undefined && item.mimeType !== mimeType) {
    throw new Error("Cohub 返回的素材格式与内容不一致。");
  }
  if (data.length % 4 !== 0 || btoa(atob(data)) !== data) {
    throw new Error("Cohub 返回的内嵌素材内容无效。");
  }
  return item.url;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function resultError(result) {
  const messages = Array.isArray(result?.content)
    ? result.content.filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text)
    : [];
  return messages.join("\n") || "Cohub 未能返回结果。";
}

/** Validate the server result before replacing any previously displayed work. */
export function readCardResult(result) {
  if (!object(result)) throw new Error("Cohub 返回了无法读取的结果。");
  if (result.isError) throw new Error(resultError(result));
  const card = result.structuredContent;
  if (!object(card)) throw new Error("Cohub 结果缺少作品信息。");
  if (!Object.hasOwn(STATUSES, card.kind)) throw new Error("Cohub 返回了不支持的作品类型。");
  if (!STATUSES[card.kind].has(card.status)) throw new Error("Cohub 返回了无法识别的作品状态。");
  requiredString(card.spaceId, "空间编号");
  requiredString(card.id, "作品编号");
  optionalString(card.title, "作品名称");
  optionalString(card.prompt, "创作描述");
  optionalString(card.model, "生成模型");
  optionalString(card.error, "错误信息");
  requiredString(card.checkedAt, "查询时间");
  if (!Number.isFinite(Date.parse(card.checkedAt))) throw new Error("Cohub 返回的查询时间无效。");
  if (!Array.isArray(card.media)) throw new Error("Cohub 结果缺少素材列表。");
  card.media.forEach((item) => {
    if (!object(item) || !["image", "video", "audio"].includes(item.type)) {
      throw new Error("Cohub 返回了无法识别的素材。");
    }
    optionalString(item.mimeType, "素材格式");
    mediaUrl(item);
  });
  if (card.url !== undefined) httpUrl(card.url, "作品地址");
  if (card.version !== undefined && (!Number.isInteger(card.version) || card.version < 1)) {
    throw new Error("Cohub 返回的版本号无效。");
  }
  if (card.visibility !== undefined && !["public", "space"].includes(card.visibility)) {
    throw new Error("Cohub 返回的访问范围无法识别。");
  }
  if (card.billing !== undefined) {
    if (!object(card.billing) || !Number.isFinite(card.billing.amountUsd) || card.billing.amountUsd < 0) {
      throw new Error("Cohub 返回的费用信息无效。");
    }
    requiredString(card.billing.status, "费用状态");
  }
  return card;
}

/** A precise selection, not an instruction to start another paid operation. */
export function continuationPrompt(card) {
  const reference = {
    kind: card.kind,
    spaceId: card.spaceId,
    id: card.id,
    ...(card.version === undefined ? {} : { version: card.version }),
  };
  return `我想继续修改这${card.kind === "publication" ? "个 Cohub 应用" : "份 Cohub 作品"}。请先问我想改哪里，等我说明后再开始生成或发布。\n\n作品引用：${JSON.stringify(reference)}`;
}

/**
 * The same view is used by the MCP App and the local preview.
 * transport: { callTool(name, args), sendMessage(prompt), openLink(url) }
 */
export function mountCard(root, transport) {
  if (!root?.ownerDocument) throw new Error("mountCard requires a DOM root.");
  if (!object(transport)) throw new Error("mountCard requires a transport.");
  root.classList.add("cohub-mount");
  const doc = root.ownerDocument;
  let card = null;
  let refreshError = "";
  let actionError = "";
  let actionNotice = "";
  let busyAction = null;
  let mediaSignature = "";
  let revision = 0;
  let timer = null;
  let inFlight = false;
  let destroyed = false;
  let capabilities = {
    callTool: typeof transport.callTool === "function",
    sendMessage: typeof transport.sendMessage === "function",
    openLink: typeof transport.openLink === "function",
  };

  root.innerHTML = `
    <article class="cohub-card" aria-label="Cohub 作品">
      <header class="card-rail">
        <div class="card-origin"><span class="cohub-wordmark">cohub</span><span class="card-kind"></span></div>
        <span class="card-status" role="status"><span class="status-dot" aria-hidden="true"></span><span class="status-label"></span></span>
      </header>
      <section class="card-media" aria-label="作品预览"></section>
      <footer class="card-footer">
        <div class="card-caption"><h1 class="card-title"></h1><p class="card-meta"></p></div>
        <div class="card-actions"></div>
      </footer>
      <div class="card-notices" aria-live="polite"></div>
      <details class="card-details">
        <summary>详情 <svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
        <div class="details-content"></div>
      </details>
    </article>`;
  const find = (selector) => root.querySelector(selector);
  const shell = find(".cohub-card");
  const mediaRoot = find(".card-media");
  const actionsRoot = find(".card-actions");
  const detailsRoot = find(".details-content");
  const noticesRoot = find(".card-notices");

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function stopTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedulePoll() {
    stopTimer();
    if (!destroyed && card && LIVE_STATUSES.has(card.status) && capabilities.callTool && !doc.hidden && !inFlight) {
      timer = setTimeout(refresh, 5000);
    }
  }

  async function refresh() {
    stopTimer();
    if (destroyed || !card || doc.hidden || inFlight || !capabilities.callTool) return;
    const requestRevision = revision;
    const args = { kind: card.kind, spaceId: card.spaceId, id: card.id };
    inFlight = true;
    try {
      const result = await transport.callTool("read_card", args);
      if (!destroyed && requestRevision === revision) render(result);
    } catch (error) {
      if (!destroyed && requestRevision === revision) showError(error);
    } finally {
      inFlight = false;
      schedulePoll();
    }
  }

  function notice(text, type = "info") {
    const node = element("p", `card-notice card-notice--${type}`, text);
    if (type === "error") node.setAttribute("role", "alert");
    noticesRoot.append(node);
  }

  function drawNotices() {
    noticesRoot.replaceChildren();
    if (refreshError) {
      notice(card ? `暂时未能更新，显示的是上次结果。${refreshError}` : refreshError, "error");
    }
    if (card?.status === "failed") notice(card.error || "这次生成未成功，Cohub 没有返回具体原因。", "error");
    if (actionError) notice(actionError, "error");
    if (actionNotice) notice(actionNotice);
    if (card && LIVE_STATUSES.has(card.status) && !capabilities.callTool) {
      notice("当前聊天不支持自动更新，可在对话中查询生成进度。");
    }
    if (card && !LIVE_STATUSES.has(card.status) && !capabilities.sendMessage) {
      notice("当前聊天不支持从卡片继续，可直接在对话中描述修改。");
    }
    if (card && !capabilities.openLink && (card.media.some(item => !item.url.startsWith("data:")) || card.url)) {
      notice("当前聊天不支持打开链接，地址保留在详情中。");
    }
  }

  function drawMedia() {
    const nextSignature = JSON.stringify(card?.media.length
      ? card.media
      : [card?.kind, card?.status, card?.title, card?.url, Boolean(refreshError)]);
    if (mediaSignature === nextSignature) return;
    mediaSignature = nextSignature;
    mediaRoot.replaceChildren();
    if (card?.media.length) {
      const grid = element("div", `media-grid${card.media.length > 1 ? " media-grid--multiple" : ""}`);
      card.media.forEach((item, index) => {
        const figure = element("figure", `media-item media-item--${item.type}`);
        const media = element(item.type === "image" ? "img" : item.type, "work-media");
        media.src = item.url;
        if (item.type === "image") {
          media.alt = `${card.title || "Cohub 作品"}${card.media.length > 1 ? ` · ${index + 1}` : ""}`;
          media.decoding = "async";
        } else {
          media.controls = true;
          media.preload = "metadata";
          if (item.type === "video") media.playsInline = true;
          media.setAttribute("aria-label", `${card.title || "Cohub 作品"} · ${index + 1}`);
        }
        media.addEventListener("error", () => {
          if (figure.querySelector(".media-error")) return;
          figure.dataset.error = "true";
          const message = element("p", "media-error", item.url.startsWith("data:") ? "预览加载失败：素材内容无法显示。" : "预览加载失败，原始地址仍在详情中。");
          message.setAttribute("role", "alert");
          figure.append(message);
        });
        figure.append(media);
        if (card.media.length > 1) figure.append(element("figcaption", "media-index", String(index + 1).padStart(2, "0")));
        if (item.type === "audio") figure.prepend(element("div", "audio-label", "音频作品"));
        grid.append(figure);
      });
      mediaRoot.append(grid);
      return;
    }

    const stage = element("div", "empty-stage");
    if (card?.kind === "publication") {
      stage.classList.add("empty-stage--publication");
      stage.append(element("span", "stage-eyebrow", "网页应用"));
      stage.append(element("p", "publication-name", card.title || "Cohub 应用"));
      if (card.url) stage.append(element("span", "stage-address", new URL(card.url).host));
      stage.append(element("span", "stage-note", "未提供预览图"));
    } else if (card && LIVE_STATUSES.has(card.status)) {
      const progress = element("span", "working-mark");
      progress.setAttribute("aria-hidden", "true");
      stage.append(progress);
      stage.append(element("p", "stage-title", card.status === "pending" ? "等待开始" : "作品正在生成"));
      stage.append(element("p", "stage-note", "完成后会显示在这里"));
    } else if (card?.status === "completed") {
      stage.append(element("p", "stage-title", "生成已完成"));
      stage.append(element("p", "stage-note", "Cohub 未返回可预览的素材"));
    } else if (card?.status === "failed" || refreshError) {
      stage.append(element("p", "stage-title", card ? "这次未能完成" : "未能显示作品"));
    } else {
      stage.append(element("span", "waiting-mark", "·"));
      stage.append(element("p", "stage-title", "等待 Cohub 结果"));
      stage.append(element("p", "stage-note", "作品会显示在这里"));
    }
    mediaRoot.append(stage);
  }

  async function runAction(name, operation, successMessage) {
    if (busyAction || destroyed) return;
    busyAction = name;
    actionError = "";
    actionNotice = "";
    draw();
    try {
      const result = await operation();
      if (result?.isError) throw new Error(name === "continue" ? "聊天没有接收这次操作，请直接在对话中继续。" : "链接未能打开，地址保留在详情中。");
      if (!destroyed) actionNotice = successMessage || "";
    } catch (error) {
      if (!destroyed) actionError = errorMessage(error);
    } finally {
      busyAction = null;
      if (!destroyed) draw();
    }
  }

  function action(label, name, supported, operation, { primary = false, arrow = false, notice: successMessage = "" } = {}) {
    const button = element("button", `card-button${primary ? " card-button--primary" : ""}`, busyAction === name ? "请稍候…" : label);
    button.type = "button";
    button.dataset.action = name;
    button.disabled = !supported || busyAction !== null;
    if (arrow) button.insertAdjacentHTML("beforeend", ARROW);
    button.addEventListener("click", () => runAction(name, operation, successMessage));
    return button;
  }

  function drawActions() {
    actionsRoot.replaceChildren();
    if (!card || LIVE_STATUSES.has(card.status)) return;
    if (card.kind === "publication" && card.status === "published" && card.url) {
      actionsRoot.append(action("打开作品", "open-publication", capabilities.openLink, () => transport.openLink(card.url), { primary: true, arrow: true }));
    }
    actionsRoot.append(action("继续修改", "continue", capabilities.sendMessage, () => transport.sendMessage(continuationPrompt(card)), { notice: "已带回对话。告诉我想改哪里。" }));
  }

  function detailRow(list, label, value) {
    list.append(element("dt", "", label), element("dd", "", value));
  }

  function drawDetails() {
    detailsRoot.replaceChildren();
    find(".card-details").hidden = !card;
    if (!card) return;
    const list = element("dl", "details-list");
    if (card.prompt) detailRow(list, "创作描述", card.prompt);
    detailRow(list, "空间", card.spaceId);
    detailRow(list, card.kind === "publication" ? "应用" : "生成任务", card.id);
    if (card.model) detailRow(list, "模型", card.model);
    if (card.version !== undefined) detailRow(list, "版本", `v${card.version}`);
    if (card.visibility) detailRow(list, "访问范围", card.visibility === "public" ? "公开" : "空间内");
    if (card.billing) detailRow(list, "费用记录", `$${card.billing.amountUsd.toLocaleString("en-US", { maximumFractionDigits: 6 })} USD · ${card.billing.status}`);
    detailRow(list, "查询时间", new Date(card.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) + "（北京时间）");
    if (card.url) detailRow(list, "作品地址", card.url);
    detailsRoot.append(list);
    if (card.media.length) {
      const links = element("div", "media-links");
      card.media.forEach((item, index) => {
        const group = element("div", "media-link");
        const noun = { image: "原图", video: "视频", audio: "音频" }[item.type];
        if (item.url.startsWith("data:")) {
          group.append(element("span", "detail-url", `内嵌${noun} · ${item.url.slice(5, item.url.indexOf(";"))}`));
        } else {
          group.append(action(`打开${noun}${card.media.length > 1 ? ` ${index + 1}` : ""}`, `open-media-${index}`, capabilities.openLink, () => transport.openLink(item.url), { arrow: true }));
          group.append(element("span", "detail-url", item.url));
        }
        links.append(group);
      });
      detailsRoot.append(links);
    }
  }

  function draw() {
    if (destroyed) return;
    shell.dataset.status = card?.status || (refreshError ? "error" : "waiting");
    shell.dataset.stale = String(Boolean(card && refreshError));
    find(".card-kind").textContent = card ? (card.kind === "generation" ? "生成" : "发布") : "";
    find(".status-label").textContent = card ? `${LABELS[card.status]}${refreshError ? " · 待更新" : ""}` : (refreshError ? "读取失败" : "等待结果");
    const title = find(".card-title");
    title.textContent = card?.title || (card ? (card.kind === "generation" ? "Cohub 作品" : "Cohub 应用") : "");
    const meta = [];
    if (card?.kind === "publication") {
      if (card.version !== undefined) meta.push(`v${card.version}`);
      if (card.visibility) meta.push(card.visibility === "public" ? "公开" : "空间内可见");
    } else if (card?.media.length > 1) {
      meta.push(`${card.media.length} 份作品`);
    }
    find(".card-meta").textContent = meta.join(" · ");
    find(".card-meta").hidden = meta.length === 0;
    find(".card-footer").hidden = !card;
    drawMedia();
    drawActions();
    drawNotices();
    drawDetails();
  }

  function render(result) {
    if (destroyed) return;
    try {
      const next = readCardResult(result);
      const changedWork = card && (next.kind !== card.kind || next.spaceId !== card.spaceId || next.id !== card.id);
      card = next;
      revision += 1;
      refreshError = "";
      if (changedWork) {
        actionError = "";
        actionNotice = "";
        find(".card-details").open = false;
      }
      draw();
      schedulePoll();
    } catch (error) {
      showError(error);
    }
  }

  function showError(error) {
    if (destroyed) return;
    refreshError = errorMessage(error);
    draw();
  }

  function visibilityChanged() {
    if (doc.hidden) stopTimer();
    else schedulePoll();
  }

  doc.addEventListener("visibilitychange", visibilityChanged);
  draw();

  return {
    render,
    refresh,
    showError,
    setCapabilities(value) {
      capabilities = {
        callTool: value.callTool === true && typeof transport.callTool === "function",
        sendMessage: value.sendMessage === true && typeof transport.sendMessage === "function",
        openLink: value.openLink === true && typeof transport.openLink === "function",
      };
      draw();
      schedulePoll();
    },
    setHostContext(context) {
      if (context.theme === "light" || context.theme === "dark") root.dataset.theme = context.theme;
    },
    destroy() {
      destroyed = true;
      stopTimer();
      doc.removeEventListener("visibilitychange", visibilityChanged);
      root.querySelectorAll("video, audio").forEach((media) => media.pause());
    },
  };
}
