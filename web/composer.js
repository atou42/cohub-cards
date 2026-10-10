import { mountCard, readCardResult } from "./card.js";

const EDITABLE = ["title", "model", "prompt", "media", "parameters", "meta"];
const LIVE_GENERATION = new Set(["pending", "running"]);
const COMMON_FIELDS = new Set(["size", "image_size", "aspect_ratio", "ratio", "duration", "resolution"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const LABELS = { size: "尺寸", image_size: "分辨率", aspect_ratio: "画面比例", ratio: "画面比例", duration: "时长（秒）", resolution: "分辨率", quality: "质量", background: "背景", output_format: "文件格式", mode: "模式", cfg_scale: "提示词强度", negative_prompt: "避免的内容", seed: "随机种子", camera_fixed: "固定镜头", title: "标题", tags: "风格", lyrics: "歌词", negative_tags: "避免的风格", make_instrumental: "纯音乐", voice_prompt: "声音描述", metadata: "其他设置", metadata_params: "任务设置", poll_interval: "查询间隔（秒）" };
const TYPE_LABELS = { image: "图片", video: "视频", audio: "音频", speech: "语音", music: "音乐" };
const ROLE_LABELS = { first_frame: "首帧", last_frame: "尾帧", reference_image: "参考图片", reference_video: "参考视频", reference_audio: "参考音频" };
const clone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const message = error => error instanceof Error ? error.message : String(error);
const editable = draft => Object.fromEntries(EDITABLE.map(key => [key, clone(draft[key])]));

export function readComposerResult(result) {
  if (result?.isError) throw new Error(result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Cohub 未能完成这次操作。");
  const data = result?.structuredContent, draft = data?.draft;
  if (data?.kind !== "composer" || !object(draft) || typeof draft.id !== "string" || !draft.id || typeof draft.spaceId !== "string" || !draft.spaceId || !Number.isInteger(draft.revision) || draft.revision < 0) throw new Error("Cohub 草稿信息缺失或格式不正确。");
  if (!["draft", "submitting", "submitted", "unknown"].includes(draft.status) || typeof draft.title !== "string" || typeof draft.prompt !== "string" || !(draft.model === null || typeof draft.model === "string") || !Array.isArray(draft.media) || !object(draft.parameters) || !object(draft.meta)) throw new Error("Cohub 草稿内容格式不正确。");
  if (!Array.isArray(data.catalog) || !Array.isArray(data.limitations) || !data.limitations.every(item => typeof item === "string") || !Array.isArray(data.validation?.errors) || !data.validation.errors.every(item => typeof item.path === "string" && typeof item.message === "string")) throw new Error("Cohub 草稿缺少模型或校验信息。");
  if (draft.model !== null && (!object(data.model) || data.model.model !== draft.model || !Array.isArray(data.model.content?.input))) throw new Error("当前模型的官方说明尚未完整读取。");
  if (data.model !== null && !object(data.model)) throw new Error("Cohub 模型说明格式不正确。");
  if (!data.catalog.every(item => object(item) && typeof item.model === "string" && (item.title === undefined || typeof item.title === "string"))) throw new Error("Cohub 模型列表格式不正确。");
  for (const item of draft.media) {
    if (!object(item) || !["image", "video", "audio"].includes(item.type) || !object(item.source)) throw new Error("Cohub 参考素材格式不正确。");
    if (item.source.type === "url") {
      if (typeof item.source.url !== "string" || new URL(item.source.url).protocol !== "https:") throw new Error("参考素材需要有效的 HTTPS 地址。");
    } else if (item.source.type === "file") {
      if (typeof item.source.id !== "string" || !item.source.id || typeof item.source.name !== "string" || typeof item.source.mimeType !== "string" || !Number.isFinite(item.source.size) || item.source.size < 0) throw new Error("本地参考素材记录不完整。");
    } else throw new Error("Cohub 返回了无法识别的参考素材来源。");
    if (item.meta !== undefined && !object(item.meta)) throw new Error("Cohub 参考素材的用途格式不正确。");
  }
  if (data.generation !== null && data.generation !== undefined) readCardResult({ structuredContent: data.generation });
  return data;
}

export function fieldDefinitions(model) {
  return [
    ...Object.entries(model?.parameters || {}).map(([key, schema]) => ({ scope: "parameters", key, schema })),
    ...Object.entries(model?.meta?.fields || {}).map(([key, schema]) => ({ scope: "meta", key, schema })),
  ];
}

export function parseFieldValue(schema, raw) {
  if (raw === "" && schema.optional) return undefined;
  let value = raw;
  if (schema.type === "integer" || schema.type === "number") {
    if (raw === "" || !Number.isFinite(Number(raw))) throw new Error("请输入有效数字。");
    value = Number(raw);
    if (schema.type === "integer" && !Number.isInteger(value)) throw new Error("请输入整数。");
    if (schema.min !== undefined && value < schema.min) throw new Error(`不能小于 ${schema.min}。`);
    if (schema.max !== undefined && value > schema.max) throw new Error(`不能大于 ${schema.max}。`);
  } else if (schema.type === "boolean") {
    if (!["true", "false"].includes(raw)) throw new Error("请选择开或关。");
    value = raw === "true";
  } else if (schema.type === "object") {
    try { value = JSON.parse(raw); } catch { throw new Error("设置需要有效的 JSON 对象。"); }
    if (!object(value)) throw new Error("设置需要 JSON 对象，不能使用数组或单个值。");
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error("请选择模型支持的值。");
  return value;
}

export function composerLayoutMode(hostContext = {}) {
  return hostContext?.displayMode === "fullscreen" ? "expanded" : "inline";
}

/** Shared draft state. The server is authoritative; unsaved local fields stay local on conflict. */
export function createDraftSession(transport, onChange = () => {}) {
  let data = null, local = null, dirty = new Set(), conflict = null, editing = false;
  let error = "", contextError = "", uncertain = false, destroyed = false, visible = true;
  let pollTimer = null, saveTimer = null, readPromise = null, savePromise = null, submitPromise = null;
  let operation = "", contextKey = "";
  let capabilities = { callTool: typeof transport.callTool === "function", updateModelContext: false };
  const status = () => conflict?.draft.status || data?.draft.status;
  const state = () => ({ data, local, dirty: [...dirty], conflict, editing, error, contextError, uncertain, busy: operation || (savePromise ? "saving" : ""), capabilities, status: status() });
  const emit = (replace = false) => { if (!destroyed) onChange(state(), { replace }); };
  const stop = name => { if (name === "poll") { clearTimeout(pollTimer); pollTimer = null; } else { clearTimeout(saveTimer); saveTimer = null; } };
  function fail(cause) { error = message(cause); emit(); }
  function checkEditable() {
    if (destroyed) throw new Error("创作卡已关闭，未继续提交。");
    if (!capabilities.callTool) throw new Error("当前聊天不支持编辑这张创作卡。");
    if (!data || status() !== "draft" || uncertain) throw new Error("这份草稿已进入提交流程，不能再次生成。请先查看原任务结果。");
  }
  function recomputeDirty() { dirty = new Set(EDITABLE.filter(key => !equal(local[key], data.draft[key]))); }
  function schedule() {
    stop("poll");
    const finished = data?.draft.status === "submitted" && data.generation && !LIVE_GENERATION.has(data.generation.status);
    if (!destroyed && visible && data && capabilities.callTool && !operation && !savePromise && !readPromise && !finished) pollTimer = setTimeout(() => { refresh().catch(fail); }, 4000);
  }
  function scheduleSave() {
    stop("save");
    if (!destroyed && dirty.size && !conflict && !operation && capabilities.callTool && status() === "draft") saveTimer = setTimeout(() => { save().catch(fail); }, 650);
  }
  function notify() {
    if (!data || !capabilities.updateModelContext || typeof transport.updateModelContext !== "function") return;
    const key = `${data.draft.id}:${data.draft.revision}:${data.draft.status}`;
    if (key === contextKey) return;
    contextKey = key;
    const note = JSON.stringify({ cohubDraft: data.draft.id, revision: data.draft.revision, model: data.draft.model, status: data.draft.status, prompt: data.draft.prompt.slice(0, 160), ...(data.draft.taskRunId ? { taskRunId: data.draft.taskRunId } : {}) });
    Promise.resolve().then(() => transport.updateModelContext(note)).then(result => {
      if (result?.isError) throw new Error("当前聊天未接收草稿上下文。");
      contextError = ""; emit();
    }).catch(cause => { contextError = `草稿已保存，但对话上下文未能更新：${message(cause)}`; emit(); });
  }
  function adopt(next) {
    data = next; local = editable(next.draft); dirty.clear(); conflict = null;
    error = ""; uncertain = next.draft.status === "unknown";
    emit(true); notify(); schedule();
  }
  function receive(result, { force = false, newDraft = false } = {}) {
    if (destroyed) return;
    const next = readComposerResult(result);
    if (data && next.draft.id !== data.draft.id && !newDraft) throw new Error("返回结果属于另一份草稿，当前输入已保留。");
    if (!data || newDraft) return adopt(next);
    if (next.draft.revision < data.draft.revision) return;
    if (next.draft.revision === data.draft.revision) {
      data = next; if (next.draft.status === "unknown") uncertain = true;
      emit(); notify(); schedule(); return;
    }
    if (!force && (dirty.size || editing)) {
      conflict = next; error = dirty.size ? "草稿已在另一边更新，你的输入已保留。请选择如何继续。" : "草稿有新内容，结束输入后同步。";
      stop("save"); emit(); schedule(); return;
    }
    adopt(next);
  }
  async function refresh({ force = false } = {}) {
    if (destroyed || !data || !visible || !capabilities.callTool) return;
    if (readPromise) return readPromise;
    stop("poll");
    const draftId = data.draft.id;
    readPromise = (async () => {
      try {
        const result = await transport.callTool("read_generation_draft", { draftId });
        if (!destroyed && data.draft.id === draftId) receive(result, { force });
      } catch (cause) { fail(cause); throw cause; }
      finally { readPromise = null; schedule(); }
    })();
    return readPromise;
  }
  function edit(patch) {
    checkEditable();
    if (operation) throw new Error("当前操作尚未完成，请稍候。");
    for (const [key, value] of Object.entries(patch)) {
      if (!EDITABLE.includes(key)) throw new Error(`不能修改草稿字段：${key}`);
      local[key] = clone(value);
    }
    recomputeDirty(); error = conflict ? error : ""; emit(); scheduleSave();
  }
  async function save() {
    if (savePromise) return savePromise;
    checkEditable();
    if (conflict) throw new Error("草稿存在未处理的版本冲突，尚未保存或生成。");
    if (!dirty.size) return data;
    stop("save"); stop("poll");
    const sent = clone(local), draftId = data.draft.id, baseRevision = data.draft.revision;
    const patch = Object.fromEntries([...dirty].map(key => [key, clone(local[key])]));
    savePromise = (async () => {
      let saved = false;
      try {
        const next = readComposerResult(await transport.callTool("update_generation_draft", { draftId, baseRevision, patch }));
        if (destroyed) return next;
        if (next.draft.id !== draftId || next.draft.revision <= baseRevision) throw new Error("保存回执的草稿或版本不正确，当前输入已保留。");
        const newerEdits = Object.fromEntries(EDITABLE.filter(key => !equal(local[key], sent[key])).map(key => [key, clone(local[key])]));
        data = next; local = { ...editable(next.draft), ...newerEdits }; recomputeDirty();
        if (conflict?.draft.revision <= next.draft.revision) conflict = null;
        error = ""; saved = true; emit(true); notify();
        return next;
      } catch (cause) { fail(new Error(`保存未完成，输入已保留。${message(cause)}`)); throw cause; }
      finally { savePromise = null; emit(); schedule(); if (saved) scheduleSave(); }
    })();
    emit();
    return savePromise;
  }
  async function submit() {
    if (submitPromise) return submitPromise;
    checkEditable();
    if (operation) throw new Error("当前操作尚未完成。");
    operation = "submitting"; stop("save"); stop("poll"); emit();
    submitPromise = (async () => {
      let sent = false, acknowledged = false;
      try {
        await save();
        while (dirty.size) await save();
        await refresh({ force: true });
        checkEditable();
        if (dirty.size || conflict) throw new Error("输入尚未保存，不能提交旧版本。");
        if (!data.draft.model) throw new Error("请先选择模型。");
        if (data.validation.errors.length) throw new Error(data.validation.errors.map(item => item.message).join("\n"));
        sent = true;
        const result = await transport.callTool("submit_generation", { draftId: data.draft.id, baseRevision: data.draft.revision });
        const next = readComposerResult(result); acknowledged = true; receive(result, { force: true });
        if (next.draft.status === "draft") throw new Error(next.draft.error || next.validation.errors.map(item => item.message).join("\n") || "草稿未提交，请检查输入。");
        return next;
      } catch (cause) {
        if (sent && !acknowledged) uncertain = true;
        fail(cause); throw cause;
      } finally { operation = ""; submitPromise = null; emit(); schedule(); }
    })();
    return submitPromise;
  }
  async function addReference(reference) {
    checkEditable();
    if (operation) throw new Error("当前操作尚未完成。");
    operation = "reference"; stop("save"); emit();
    try {
      await save(); while (dirty.size) await save();
      await refresh({ force: true }); checkEditable();
      if (dirty.size || conflict) throw new Error("请先处理草稿冲突，再添加素材。");
      const result = await transport.callTool("add_generation_reference", { draftId: data.draft.id, baseRevision: data.draft.revision, ...reference });
      receive(result, { force: true }); return data;
    } catch (cause) { fail(cause); throw cause; }
    finally { operation = ""; emit(); schedule(); }
  }
  async function recreate() {
    if (!data || !capabilities.callTool || operation || uncertain || status() !== "submitted") throw new Error("请先确认原任务结果，再创建新的草稿。");
    operation = "recreating"; emit();
    try {
      const result = await transport.callTool("prepare_generation", { spaceId: data.draft.spaceId, ...clone(local) });
      const next = readComposerResult(result);
      if (next.draft.id === data.draft.id || next.draft.status !== "draft") throw new Error("Cohub 未返回新的创作草稿。");
      receive(result, { newDraft: true }); return data;
    } catch (cause) { fail(cause); throw cause; }
    finally { operation = ""; emit(); schedule(); }
  }
  function resolveConflict(choice) {
    if (!conflict) return;
    const next = conflict;
    if (choice === "remote") return adopt(next);
    if (choice !== "local" || next.draft.status !== "draft") throw new Error("这份草稿已提交，请先载入原任务结果。");
    const mine = Object.fromEntries([...dirty].map(key => [key, clone(local[key])]));
    data = next; local = { ...editable(next.draft), ...mine }; conflict = null; recomputeDirty(); error = "";
    emit(true); scheduleSave(); schedule();
  }
  return {
    state, receive, edit, save, submit, refresh, addReference, recreate, resolveConflict, showError: fail,
    setEditing(value) { editing = value; if (!editing && conflict && !dirty.size) adopt(conflict); else emit(); },
    setVisible(value) { visible = value; if (!value) stop("poll"); else schedule(); },
    setCapabilities(value) { capabilities = { callTool: value.callTool === true && typeof transport.callTool === "function", updateModelContext: value.updateModelContext === true }; emit(); notify(); schedule(); },
    destroy() { destroyed = true; stop("poll"); stop("save"); },
  };
}

export function readReferenceFile(file, type) {
  if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error("单个文件不能超过 20 MiB。"));
  if (file.size === 0) return Promise.reject(new Error("不能添加空文件。"));
  if (!file.type?.startsWith(`${type}/`) || file.type === "image/svg+xml") return Promise.reject(new Error(`请选择可用的${TYPE_LABELS[type]}文件。`));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("文件读取失败，请重新选择。"));
    reader.onabort = () => reject(new Error("文件读取已取消。"));
    reader.onload = () => {
      const content = String(reader.result), separator = content.indexOf(",");
      if (separator < 0 || !content.slice(0, separator).endsWith(";base64")) return reject(new Error("文件未能转换为可上传的内容。"));
      resolve({ type, name: file.name, mimeType: file.type, base64: content.slice(separator + 1) });
    };
    reader.readAsDataURL(file);
  });
}

/** Presentation and editing share this one draft; the result reuses the existing media card. */
export function mountComposer(root, transport) {
  const doc = root.ownerDocument;
  root.classList.add("cohub-mount");
  root.innerHTML = `<article class="cohub-composer">
    <header class="composer-rail"><span class="cohub-wordmark">cohub</span><span class="composer-status" role="status">等待草稿</span></header>
    <section class="composer-stage" aria-label="作品预览"></section>
    <section class="composer-editor" aria-label="创作输入"><div class="composer-model"></div><div class="composer-prompt"></div><div class="composer-common"></div><div class="composer-settings"></div><div class="composer-references"></div></section>
    <div class="composer-feedback" aria-live="polite"></div>
    <footer class="composer-footer"><span class="composer-save-state"></span><div class="composer-actions"><button type="button" class="composer-text-button composer-display-mode">展开编辑</button><button type="button" class="composer-generate">生成</button></div></footer>
  </article>`;
  const find = selector => root.querySelector(selector);
  const stage = find(".composer-stage"), feedback = find(".composer-feedback"), primary = find(".composer-generate"), displayButton = find(".composer-display-mode");
  const invalid = new Map();
  let formKey = "", mediaFormKey = "", stageKey = "", resultView = null, hostContext = {}, capabilities = { callTool: false, sendMessage: false, openLink: false, updateModelContext: false };
  let destroyed = false, readingFile = false, changingDisplayMode = false, displayError = "";
  const session = createDraftSession(transport, (state, change) => draw(state, change));
  const element = (tag, className = "", text) => {
    const node = doc.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const handle = operation => Promise.resolve().then(operation).catch(cause => session.showError(cause));
  function button(label, action, className = "composer-small-button") {
    const node = element("button", className, label); node.type = "button";
    node.addEventListener("click", () => handle(action)); return node;
  }
  function option(select, value, label) {
    const node = element("option", "", label); node.value = value; select.append(node);
  }
  function editField(scope, key, value) {
    const next = clone(session.state().local[scope]);
    if (value === undefined) delete next[key]; else next[key] = value;
    session.edit({ [scope]: next });
  }
  function field(scope, key, schema, rawValue) {
    const label = element("label", `composer-field${schema.type === "object" || /lyrics|prompt/.test(key) ? " composer-field--wide" : ""}`);
    label.append(element("span", "composer-field-label", LABELS[key] || key));
    let input;
    const defaultLabel = schema.default === undefined ? "未设置" : `默认 · ${typeof schema.default === "boolean" ? (schema.default ? "开" : "关") : schema.default}`;
    if (schema.enum || schema.type === "boolean") {
      input = element("select");
      if (schema.optional) option(input, "", defaultLabel);
      for (const value of schema.enum || [true, false]) option(input, String(value), typeof value === "boolean" ? (value ? "开" : "关") : String(value));
    } else if (schema.type === "object" || /lyrics|prompt/.test(key)) {
      input = element("textarea"); input.rows = schema.type === "object" ? 4 : 3;
    } else {
      input = element("input"); input.type = ["integer", "number"].includes(schema.type) ? "number" : "text";
      if (input.type === "number") { input.step = schema.type === "integer" ? "1" : "any"; if (schema.min !== undefined) input.min = String(schema.min); if (schema.max !== undefined) input.max = String(schema.max); }
    }
    input.dataset.field = `${scope}.${key}`;
    input.value = rawValue === undefined ? "" : schema.type === "object" ? JSON.stringify(rawValue, null, 2) : String(rawValue);
    input.placeholder = schema.default === undefined ? (schema.optional ? "可选" : "必填") : String(schema.default);
    if (schema.description) input.title = schema.description;
    input.addEventListener("change", () => {
      try {
        const value = parseFieldValue(schema, input.value); invalid.delete(input.dataset.field);
        input.removeAttribute("aria-invalid"); editField(scope, key, value);
      } catch (cause) { invalid.set(input.dataset.field, `${LABELS[key] || key}：${message(cause)}`); input.setAttribute("aria-invalid", "true"); draw(session.state()); }
    });
    label.append(input); return label;
  }
  function renderForm(state) {
    const { data, local } = state;
    for (const selector of [".composer-model", ".composer-prompt", ".composer-common", ".composer-settings"]) find(selector).replaceChildren();
    if (!data) return;
    const modelRow = find(".composer-model"), modelSelect = element("select", "composer-model-select");
    modelSelect.setAttribute("aria-label", "生成模型"); option(modelSelect, "", "选择模型");
    if (data.catalog.every(item => item.category === undefined)) {
      for (const item of data.catalog) option(modelSelect, item.model, item.title ?? item.model);
    } else {
      for (const category of [...new Set(data.catalog.map(item => item.category || "other"))]) {
        const group = element("optgroup"); group.label = TYPE_LABELS[category] || "其他";
        for (const item of data.catalog.filter(entry => (entry.category || "other") === category)) option(group, item.model, item.title ?? item.model);
        modelSelect.append(group);
      }
    }
    modelSelect.value = local.model || "";
    modelSelect.addEventListener("change", () => handle(() => session.edit({ model: modelSelect.value || null })));
    modelRow.append(modelSelect);
    const price = data.model?.pricing;
    if (price) {
      const amount = Number.isFinite(price.amount) ? `$${price.amount}` : (Number.isFinite(price.min) && Number.isFinite(price.max) ? `$${price.min}–${price.max}` : "");
      if (amount) modelRow.append(element("span", "composer-price", `参考 ${amount} / ${{ image: "张", second: "秒", request: "次", "1m_tokens": "百万 tokens" }[price.unit] || price.unit}`));
    }
    const prompt = element("textarea", "composer-prompt-input"); prompt.rows = 4; prompt.value = local.prompt;
    prompt.placeholder = "描述你想创作的内容，也可以让 Codex 帮你填写…"; prompt.setAttribute("aria-label", "创作描述");
    prompt.addEventListener("input", () => handle(() => session.edit({ prompt: prompt.value })));
    find(".composer-prompt").append(prompt);
    const definitions = fieldDefinitions(data.model), advanced = element("details", "composer-disclosure");
    advanced.append(element("summary", "", "更多设置"));
    const advancedFields = element("div", "composer-field-grid"); advanced.append(advancedFields);
    for (const { scope, key, schema } of definitions) {
      const destination = scope === "parameters" && COMMON_FIELDS.has(key) && schema.type !== "object" ? find(".composer-common") : advancedFields;
      destination.append(field(scope, key, schema, local[scope][key]));
    }
    for (const scope of ["parameters", "meta"]) {
      const keys = new Set(definitions.filter(item => item.scope === scope).map(item => item.key));
      const extra = Object.fromEntries(Object.entries(local[scope]).filter(([key]) => !keys.has(key)));
      if (Object.keys(extra).length) {
        const label = element("label", "composer-field composer-field--wide");
        label.append(element("span", "composer-field-label", scope === "parameters" ? "其他参数（已保留）" : "其他设置（已保留）"));
        const input = element("textarea"); input.rows = 4; input.value = JSON.stringify(extra, null, 2);
        input.addEventListener("change", () => {
          try {
            const next = parseFieldValue({ type: "object" }, input.value); invalid.delete(`${scope}.extra`);
            const known = Object.fromEntries(Object.entries(session.state().local[scope]).filter(([key]) => keys.has(key)));
            session.edit({ [scope]: { ...known, ...next } });
          } catch (cause) { invalid.set(`${scope}.extra`, message(cause)); draw(session.state()); }
        }); label.append(input); advancedFields.append(label);
      }
    }
    if (advancedFields.children.length) find(".composer-settings").append(advanced);
  }
  function renderReferences(state) {
    const target = find(".composer-references"); target.replaceChildren();
    const inputs = state.data?.model?.content?.input.filter(item => ["image", "video", "audio"].includes(item.type)) || [];
    if (!inputs.length && !state.local?.media.length) return;
    const disclosure = element("details", "composer-disclosure composer-reference-disclosure");
    disclosure.append(element("summary", "", `参考素材${state.local.media.length ? ` · ${state.local.media.length}` : ""}`));
    const content = element("div", "composer-reference-content"); disclosure.append(content);
    const weighted = state.data.model?.examples?.some(example => example.request?.content?.some(item => item.meta?.weight !== undefined));
    state.local.media.forEach((item, index) => {
      const row = element("div", "composer-reference-row");
      const name = item.source.type === "file" ? item.source.name : new URL(item.source.url).pathname.split("/").at(-1) || new URL(item.source.url).hostname;
      row.append(element("span", "composer-reference-name", `${TYPE_LABELS[item.type]} · ${name}`));
      const declaration = inputs.find(entry => entry.type === item.type);
      if (declaration?.roles?.length || item.meta?.role) {
        const role = element("select"); role.setAttribute("aria-label", `素材 ${index + 1} 的用途`);
        option(role, "", declaration?.roleRequired ? "请选择用途" : "默认用途");
        for (const value of [...new Set([...(declaration?.roles || []), ...(item.meta?.role ? [item.meta.role] : [])])]) option(role, value, ROLE_LABELS[value] || value);
        role.value = item.meta?.role || "";
        role.addEventListener("change", () => handle(() => {
          const media = clone(session.state().local.media); media[index].meta = { ...media[index].meta };
          if (role.value) media[index].meta.role = role.value; else delete media[index].meta.role;
          session.edit({ media });
        })); row.append(role);
      }
      if ((item.type === "audio" && weighted) || item.meta?.weight !== undefined) {
        const weight = element("input", "composer-weight"); weight.type = "number"; weight.step = "any"; weight.min = "0";
        weight.value = item.meta?.weight === undefined ? "" : String(item.meta.weight); weight.placeholder = "权重"; weight.setAttribute("aria-label", `素材 ${index + 1} 的权重`);
        weight.addEventListener("change", () => {
          const key = `media.${index}.weight`;
          if (weight.value !== "" && (!Number.isFinite(Number(weight.value)) || Number(weight.value) <= 0)) { invalid.set(key, "音频权重必须大于 0。"); draw(session.state()); return; }
          invalid.delete(key); const media = clone(session.state().local.media); media[index].meta = { ...media[index].meta };
          if (weight.value) media[index].meta.weight = Number(weight.value); else delete media[index].meta.weight;
          handle(() => session.edit({ media }));
        }); row.append(weight);
      }
      row.append(button("移除", () => session.edit({ media: session.state().local.media.filter((_, i) => i !== index) }), "composer-text-button")); content.append(row);
    });
    if (inputs.length) {
      const addRow = element("div", "composer-reference-add"), type = element("select"), role = element("select"), url = element("input");
      type.setAttribute("aria-label", "素材类型"); role.setAttribute("aria-label", "新素材用途"); url.type = "url"; url.placeholder = "粘贴素材链接"; url.setAttribute("aria-label", "素材链接");
      for (const input of inputs) option(type, input.type, TYPE_LABELS[input.type]);
      const file = element("input", "composer-file-input"); file.type = "file"; file.setAttribute("aria-label", "添加本地素材");
      const updateType = () => {
        const declaration = inputs.find(item => item.type === type.value); role.replaceChildren();
        option(role, "", declaration.roleRequired ? "请选择用途" : "默认用途");
        for (const value of declaration.roles || []) option(role, value, ROLE_LABELS[value] || value);
        if (declaration.roleRequired && declaration.roles?.length === 1) role.value = declaration.roles[0];
        role.hidden = !declaration.roles?.length; file.accept = `${type.value}/*`;
      };
      type.addEventListener("change", updateType); updateType();
      const referenceRole = () => {
        const declaration = inputs.find(item => item.type === type.value);
        if (declaration.roleRequired && !role.value) throw new Error("请先选择素材用途。");
        return role.value ? { role: role.value } : {};
      };
      addRow.append(type, role, url, button("添加", async () => {
        const parsed = new URL(url.value); if (parsed.protocol !== "https:") throw new Error("参考素材需要 HTTPS 链接。");
        await session.addReference({ type: type.value, url: parsed.href, ...referenceRole() });
      })); content.append(addRow);
      const fileLabel = element("label", "composer-file-label", "选择本地文件"); fileLabel.append(file); content.append(fileLabel);
      file.addEventListener("change", () => handle(async () => {
        if (!file.files?.length) return;
        const selected = file.files[0], selectedType = type.value, selectedRole = referenceRole();
        readingFile = true; draw(session.state());
        try { const reference = await readReferenceFile(selected, selectedType); await session.addReference({ ...reference, ...selectedRole }); }
        finally { readingFile = false; draw(session.state()); }
      }));
      content.append(element("p", "composer-help", "本地素材会在提交时上传为可访问链接，供模型读取。单个文件最多 20 MiB。"));
    }
    target.append(disclosure);
  }
  function drawStage(state) {
    const generation = state.data?.generation;
    const signature = JSON.stringify(generation ? ["result", generation] : ["draft", state.local?.media]);
    if (signature === stageKey) return;
    stageKey = signature;
    if (generation) {
      if (!resultView) {
        stage.replaceChildren(); const resultRoot = element("div", "composer-result"); stage.append(resultRoot);
        resultView = mountCard(resultRoot, transport);
      }
      // The composer owns polling. Keep result presentation and errors from the existing card.
      resultView.setCapabilities({ ...capabilities, callTool: false }); resultView.setHostContext(hostContext); resultView.render({ structuredContent: generation });
      return;
    }
    resultView?.destroy(); resultView = null; stage.replaceChildren();
    const references = state.local?.media || [], images = references.filter(item => item.type === "image" && item.source.type === "url");
    if (images.length) {
      const grid = element("div", `composer-reference-preview${images.length > 1 ? " composer-reference-preview--grid" : ""}`);
      for (const [index, item] of images.slice(0, 4).entries()) {
        const image = element("img"); image.src = item.source.url; image.alt = `参考图片 ${index + 1}`;
        image.addEventListener("error", () => session.showError(new Error(`参考图片 ${index + 1} 无法预览，素材记录仍已保留。`))); grid.append(image);
      }
      stage.append(grid, element("p", "composer-preview-caption", `参考素材${images.length > 4 ? ` · 另有 ${images.length - 4} 张` : ""} · 生成结果会显示在这里`));
    } else {
      const empty = element("div", "composer-empty");
      empty.append(element("span", "composer-empty-mark", "✳"), element("p", "composer-empty-title", references.length ? "参考素材已就位" : "在这里看见你的作品"));
      empty.append(element("p", "composer-help", references.length ? references.map(item => item.source.type === "file" ? item.source.name : TYPE_LABELS[item.type]).join(" · ") : "填写创作描述，再生成图片、视频或声音")); stage.append(empty);
    }
  }
  function drawFeedback(state) {
    feedback.replaceChildren();
    const add = (text, kind = "error") => { const node = element("p", `composer-notice composer-notice--${kind}`, text); if (kind === "error") node.setAttribute("role", "alert"); feedback.append(node); };
    if (!capabilities.callTool) add("当前聊天不支持在卡片里保存或生成，可在对话中继续。", "info");
    if (displayError) add(displayError);
    if (state.error) add(state.error);
    if (state.data?.draft.error && state.data.draft.error !== state.error) add(state.data.draft.error);
    if (state.uncertain || state.status === "unknown") add("提交结果尚未确认。为避免重复生成，请先查询原任务。", "info");
    for (const value of invalid.values()) add(value);
    for (const item of state.data?.validation.errors || []) add(`${LABELS[item.path.split(".").at(-1)] || item.path}：${item.message}`);
    if (composerLayoutMode(hostContext) === "inline" && (invalid.size || state.data?.validation.errors.length)) add("可点“展开编辑”检查参数和参考素材。", "info");
    for (const limitation of state.data?.limitations || []) add(limitation, "info");
    if (state.contextError) add(state.contextError, "info");
    if (state.conflict && state.dirty.length) {
      const choices = element("div", "composer-conflict-actions");
      choices.append(button("使用最新内容", () => { invalid.clear(); session.resolveConflict("remote"); }));
      if (state.conflict.draft.status === "draft") choices.append(button("保留我的修改", () => session.resolveConflict("local")));
      feedback.append(choices);
    } else if (state.error && state.dirty.length && !state.busy && state.status === "draft") feedback.append(button("重试保存", () => session.save()));
  }
  function draw(state, change = {}) {
    if (destroyed) return;
    const nextKey = state.data ? JSON.stringify([state.data.draft.id, state.data.model?.model, fieldDefinitions(state.data.model)]) : "empty";
    if (nextKey !== formKey || (change.replace && !state.editing)) { formKey = nextKey; renderForm(state); }
    const nextMediaKey = JSON.stringify([state.data?.model?.model, state.local?.media]);
    if (nextMediaKey !== mediaFormKey) { mediaFormKey = nextMediaKey; renderReferences(state); }
    drawStage(state); drawFeedback(state);
    const generating = LIVE_GENERATION.has(state.data?.generation?.status);
    const terminal = state.status === "submitted" && state.data?.generation && !generating;
    const statusText = state.uncertain ? "待确认" : state.busy === "submitting" ? "正在提交" : state.status === "submitting" ? "正在提交" : generating ? "正在生成" : terminal ? (state.data.generation.status === "failed" ? "生成失败" : "已完成") : state.conflict ? "有新版本" : state.data ? "创作草稿" : "等待草稿";
    find(".composer-status").textContent = statusText;
    find(".composer-save-state").textContent = readingFile ? "正在读取文件…" : state.busy === "reference" ? "正在添加素材…" : state.busy === "saving" ? "正在保存…" : state.dirty.length ? "尚未保存" : state.data ? `已同步 · v${state.data.draft.revision}` : "";
    const locked = !capabilities.callTool || !state.data || state.status !== "draft" || state.uncertain || (state.busy && state.busy !== "saving") || readingFile;
    for (const control of find(".composer-editor").querySelectorAll("input, textarea, select, button")) control.disabled = Boolean(locked);
    const modelSelect = find(".composer-model-select"); if (modelSelect && invalid.size) modelSelect.disabled = true;
    primary.textContent = terminal ? "再创作" : state.busy === "submitting" || state.status === "submitting" ? "正在提交…" : state.status === "submitted" ? "已提交" : "生成";
    primary.disabled = !capabilities.callTool || !state.data || Boolean(state.busy && state.busy !== "saving") || readingFile || state.uncertain || Boolean(state.conflict) || invalid.size > 0 || (!terminal && (state.status !== "draft" || !state.local?.model || state.data.validation.errors.length > 0));
    const layout = composerLayoutMode(hostContext), compact = layout === "inline";
    find(".cohub-composer").dataset.layout = layout;
    for (const selector of [".composer-common", ".composer-settings", ".composer-references"]) find(selector).hidden = compact;
    const prompt = find(".composer-prompt-input"); if (prompt) prompt.rows = compact ? 2 : 4;
    displayButton.textContent = compact ? "展开编辑" : "返回聊天";
    displayButton.disabled = changingDisplayMode || !state.data || !canRequestDisplayMode(compact ? "fullscreen" : "inline");
    displayButton.title = displayButton.disabled && !changingDisplayMode ? (compact ? "当前聊天不支持展开编辑" : "当前宿主不支持返回聊天") : "";
  }
  function canRequestDisplayMode(mode) {
    return typeof transport.requestDisplayMode === "function" && (mode === "fullscreen" ? capabilities.expand === true : hostContext.availableDisplayModes?.includes("inline") === true);
  }
  displayButton.addEventListener("click", async () => {
    const target = composerLayoutMode(hostContext) === "inline" ? "fullscreen" : "inline";
    if (destroyed || changingDisplayMode || !canRequestDisplayMode(target)) return;
    changingDisplayMode = true; displayError = ""; draw(session.state());
    try {
      const response = await transport.requestDisplayMode(target);
      if (destroyed) return;
      if (response?.isError || !["inline", "fullscreen", "pip"].includes(response?.mode)) throw new Error("宿主未返回有效的显示模式。");
      hostContext = { ...hostContext, displayMode: response.mode };
      resultView?.setHostContext(hostContext);
      if (response.mode !== target) throw new Error("宿主未切换到请求的显示模式。");
    } catch (cause) {
      if (!destroyed) displayError = `${target === "fullscreen" ? "无法展开编辑" : "无法返回聊天"}：${message(cause)}`;
    } finally { if (!destroyed) { changingDisplayMode = false; draw(session.state()); } }
  });
  primary.addEventListener("click", () => handle(() => session.state().status === "submitted" ? session.recreate() : session.submit()));
  function focusChanged() {
    queueMicrotask(() => {
      if (destroyed) return;
      session.setEditing(invalid.size > 0 || Boolean(root.contains(doc.activeElement) && doc.activeElement?.matches("input, textarea, select")));
    });
  }
  function visibilityChanged() { session.setVisible(!doc.hidden); }
  root.addEventListener("focusin", focusChanged); root.addEventListener("focusout", focusChanged); doc.addEventListener("visibilitychange", visibilityChanged);
  draw(session.state()); session.setVisible(!doc.hidden);
  return {
    render(result) { try { session.receive(result); } catch (cause) { session.showError(cause); } },
    showError: cause => session.showError(cause),
    setCapabilities(value) { capabilities = value; session.setCapabilities(value); resultView?.setCapabilities({ ...value, callTool: false }); },
    setHostContext(context) { hostContext = { ...hostContext, ...context }; if (["light", "dark"].includes(context.theme)) root.dataset.theme = context.theme; resultView?.setHostContext(hostContext); draw(session.state()); },
    destroy() { destroyed = true; session.destroy(); resultView?.destroy(); root.removeEventListener("focusin", focusChanged); root.removeEventListener("focusout", focusChanged); doc.removeEventListener("visibilitychange", visibilityChanged); },
  };
}
