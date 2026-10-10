import { createMediaView, createProgressView, elapsedLabel, readCardResult } from "./card.js";
import { icon } from "./icons.js";

const EDITABLE = ["title", "model", "prompt", "media", "parameters", "meta"];
const LIVE_GENERATION = new Set(["pending", "running"]);
const COMMON_FIELDS = new Set(["size", "image_size", "aspect_ratio", "ratio", "duration", "resolution"]);
const PRIMARY_FIELDS = new Set([...COMMON_FIELDS, "quality", "background", "output_format", "mode", "camera_fixed", "title", "tags", "lyrics", "make_instrumental", "voice_prompt", "negative_tags"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const LABELS = { size: "尺寸", image_size: "分辨率", aspect_ratio: "比例", ratio: "比例", duration: "时长", resolution: "分辨率", quality: "质量", background: "背景", output_format: "格式", mode: "模式", cfg_scale: "提示词强度", negative_prompt: "避免的内容", seed: "随机种子", camera_fixed: "固定镜头", title: "标题", tags: "风格", lyrics: "歌词", negative_tags: "避免的风格", make_instrumental: "纯音乐", voice_prompt: "声音描述", metadata: "其他设置", metadata_params: "任务设置", poll_interval: "查询间隔（秒）", max_side: "编辑长边上限", controlnet_weight: "参考强度", ipadapter_face_image_ref: "人脸参考图", ipadapter_face_weight: "人脸参考强度", generation_type: "生成方式" };
const VALUE_LABELS = { auto: "自动", adaptive: "自适应", std: "标准", pro: "专业", low: "低", medium: "中", high: "高", opaque: "不透明", transparent: "透明" };
const TYPE_LABELS = { image: "图片", video: "视频", audio: "音频", speech: "语音", music: "音乐" };
const KIND_LABELS = { image: "图片", video: "视频", audio: "音频", speech: "语音", music: "音乐" };
const ROLE_LABELS = { first_frame: "首帧", last_frame: "尾帧", reference_image: "参考图", reference_video: "参考视频", reference_audio: "参考音频" };
const FRAME_ROLES = ["first_frame", "last_frame"];
const UNIT_LABELS = { image: "张", second: "秒", request: "次", "1m_tokens": "百万 tokens" };
const clone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const message = error => error instanceof Error ? error.message : String(error);
const editable = draft => Object.fromEntries(EDITABLE.map(key => [key, clone(draft[key])]));

export function readComposerResult(result) {
  if (result?.isError) {
    const error = new Error(result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Cohub 未能完成这次操作。");
    if (typeof result._meta?.code === "string") error.code = result._meta.code;
    throw error;
  }
  const data = result?.structuredContent, draft = data?.draft;
  if (data?.kind !== "composer" || !object(draft) || typeof draft.id !== "string" || !draft.id || typeof draft.spaceId !== "string" || !draft.spaceId || !Number.isInteger(draft.revision) || draft.revision < 0) throw new Error("Cohub 草稿信息缺失或格式不正确。");
  if (!["draft", "submitting", "submitted", "unknown"].includes(draft.status) || typeof draft.title !== "string" || typeof draft.prompt !== "string" || !(draft.model === null || typeof draft.model === "string") || !Array.isArray(draft.media) || !object(draft.parameters) || !object(draft.meta)) throw new Error("Cohub 草稿内容格式不正确。");
  if (!Array.isArray(data.catalog) || !Array.isArray(data.limitations) || !data.limitations.every(item => typeof item === "string") || !Array.isArray(data.validation?.errors) || !data.validation.errors.every(item => typeof item.path === "string" && typeof item.message === "string" && (item.kind === undefined || item.kind === "missing"))) throw new Error("Cohub 草稿缺少模型或校验信息。");
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

/** Width / height for "16:9", "1536x1024" or "768*1344". Anything else has no known shape. */
export function aspectOf(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)\s*[:x*×]\s*(\d+(?:\.\d+)?)$/i.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

function money(amount) {
  if (Number.isInteger(amount) && amount >= 10) return String(amount);
  const [whole, fraction = ""] = amount.toFixed(4).replace(/0+$/, "").split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

/** Reference price from the official declaration. Per-second prices are multiplied by the chosen duration. */
export function priceSummary(pricing, parameters = {}, values = {}) {
  if (!object(pricing)) return null;
  const unit = UNIT_LABELS[pricing.unit] || pricing.unit;
  const range = Number.isFinite(pricing.amount) ? null : [pricing.min, pricing.max];
  const unitText = range ? `$${money(range[0])}–${money(range[1])}/${unit}` : `$${money(pricing.amount)}/${unit}`;
  let estimate = null;
  if (pricing.unit === "second") {
    const seconds = values.duration ?? parameters?.duration?.default;
    if (Number.isFinite(seconds) && seconds > 0) estimate = range ? `≈ $${money(range[0] * seconds)}–${money(range[1] * seconds)}` : `≈ $${money(pricing.amount * seconds)}`;
  }
  return { estimate, unit: unitText };
}

/** The media type a dropped, pasted or chosen file can serve as, limited to the selected model's declared inputs. */
export function referenceTypeForFile(file, inputs) {
  const mime = typeof file?.type === "string" ? file.type : "";
  const kind = mime.split("/")[0];
  if (!["image", "video", "audio"].includes(kind) || mime === "image/svg+xml" || !inputs.some(item => item.type === kind)) {
    throw new Error(`当前模型不支持这种素材${mime ? `（${mime}）` : ""}。`);
  }
  return kind;
}

/** A required role is preset only when the choice is unambiguous: a single role, or the next free frame. */
export function defaultRoleFor(declaration, media = []) {
  const roles = declaration?.roles;
  if (!declaration?.roleRequired || !roles?.length) return undefined;
  if (roles.length === 1) return roles[0];
  if (roles.every(role => FRAME_ROLES.includes(role))) {
    const used = new Set(media.filter(item => item.type === declaration.type).map(item => item.meta?.role));
    return roles.find(role => !used.has(role));
  }
  return undefined;
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
  const emit = (replace = false, origin = "") => { if (!destroyed) onChange(state(), { replace, origin }); };
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
    emit(true, "remote"); notify(); schedule();
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
      } catch (cause) {
        if (cause?.code === "REVISION_CONFLICT" && !destroyed) {
          // Someone saved a newer copy. Load it now so the person chooses with both versions in hand.
          // refresh() reports its own failure through fail(); the handler only stops a second unhandled rejection.
          fail(new Error("草稿已在另一边更新，正在读取最新内容。你的输入已保留。"));
          refresh().catch(() => {});
        } else fail(new Error(`保存未完成，输入已保留。${message(cause)}`));
        throw cause;
      }
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

function valueLabel(key, value) {
  if (value === undefined || value === null || value === "") return "默认";
  if (typeof value === "boolean") return value ? "开" : "关";
  if (key === "duration" && Number.isFinite(value) && value >= 0) return `${value} 秒`;
  if (typeof value === "string" && VALUE_LABELS[value]) return VALUE_LABELS[value];
  if (typeof value === "string" && /^\d+\s*[x*]\s*\d+$/i.test(value)) return value.replace(/\s*[x*]\s*/i, "×");
  return String(value);
}

function pathLabel(path) {
  const parts = path.split(".");
  if (parts[0] === "prompt") return "描述";
  if (parts[0] === "model") return "模型";
  if (parts[0] === "media") return parts.length > 1 && /^\d+$/.test(parts[1]) ? `素材 ${Number(parts[1]) + 1}` : "参考素材";
  if (["parameters", "meta"].includes(parts[0]) && parts[1]) return LABELS[parts[1]] || parts[1];
  return LABELS[parts.at(-1)] || "设置";
}

function missingHint(item) {
  const parts = item.path.split(".");
  if (parts[0] === "prompt") return "写下描述后就可以生成。";
  if (parts[0] === "model") return "先选择一个模型。";
  if (parts[0] === "media" && parts.at(-1) === "role") return `为素材 ${Number(parts[1]) + 1} 选择用途。`;
  if (parts[0] === "media") return `还需要参考素材：${item.message.replace(/^(image|video|audio)\s*/, (_, type) => TYPE_LABELS[type])}`;
  return `${pathLabel(item.path)}还需要填写。`;
}

/** The stage shape: declared ratio or size, else none. */
function shapeOf(model, values = {}) {
  const parameters = model?.parameters || {};
  const parts = [];
  let ratio = null;
  for (const key of ["ratio", "aspect_ratio", "size"]) {
    if (!parameters[key]) continue;
    const value = values[key] ?? parameters[key].default;
    if (value === undefined) continue;
    ratio = aspectOf(value);
    parts.push(valueLabel(key, value));
    break;
  }
  for (const key of ["image_size", "resolution"]) {
    const value = values[key] ?? parameters[key]?.default;
    if (value !== undefined) parts.push(String(value));
  }
  const duration = values.duration ?? parameters.duration?.default;
  if (parameters.duration && Number.isFinite(duration) && duration > 0) parts.push(`${duration} 秒`);
  return { ratio, label: parts.join(" · ") };
}

function fileSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || "");

/** Presentation and editing share this one draft. The stage reuses the result card's media and progress views. */
export function mountComposer(root, transport) {
  const doc = root.ownerDocument;
  root.classList.add("cohub-mount");
  root.innerHTML = `<article class="cohub-composer cc-shell" data-layout="inline">
    <header class="composer-rail cc-rail">
      <div class="cc-origin"><span class="cohub-mark" aria-hidden="true"></span><span class="cohub-wordmark">Cohub</span><span class="composer-kind cc-crumb"></span></div>
      <div class="cc-rail-end"><span class="composer-save-state"></span><span class="composer-status status-pill" role="status"><span class="status-dot" aria-hidden="true"></span><span class="composer-status-label"></span></span><button type="button" class="composer-display-mode cc-button cc-button--quiet cc-button--small"></button></div>
    </header>
    <section class="composer-stage" aria-label="作品预览"></section>
    <section class="composer-panel" aria-label="创作设置"><div class="composer-result-details"></div><div class="composer-common"></div><div class="composer-references"></div><div class="composer-settings"></div></section>
    <div class="composer-dock">
    <div class="composer-feedback" aria-live="polite"></div>
    <section class="composer-editor" aria-label="创作输入">
      <div class="composer-box">
        <div class="composer-prompt"></div>
        <div class="composer-toolbar">
          <div class="composer-toolbar-start">
            <button type="button" class="composer-attach">${icon("plus", 16)}</button>
            <div class="composer-model"></div>
            <div class="composer-chips"></div>
          </div>
          <div class="composer-toolbar-end">
            <span class="composer-price"></span>
            <button type="button" class="composer-generate cc-button cc-button--primary"><span class="composer-generate-label">生成</span><kbd class="composer-kbd"></kbd></button>
          </div>
        </div>
      </div>
    </section>
    </div>
    <input type="file" class="composer-file-input"/>
    <div class="composer-drop" aria-hidden="true"><div class="composer-drop-inner">${icon("upload", 20)}<span>松开即可添加参考素材</span></div></div>
  </article>`;
  const find = selector => root.querySelector(selector);
  const shell = find(".cohub-composer"), stage = find(".composer-stage"), feedback = find(".composer-feedback");
  const primary = find(".composer-generate"), primaryLabel = find(".composer-generate-label"), kbd = find(".composer-kbd");
  const displayButton = find(".composer-display-mode"), attach = find(".composer-attach"), fileInput = find(".composer-file-input");
  const box = find(".composer-box"), priceNode = find(".composer-price"), chipsRoot = find(".composer-chips");
  const invalid = new Map(), previews = new Map();
  let formKey = "", mediaFormKey = "", stageKey = "", stageView = null, hostContext = {}, capabilities = { callTool: false, sendMessage: false, openLink: false, updateModelContext: false };
  let destroyed = false, readingFile = false, changingDisplayMode = false, displayError = "", lastSeen = null, syncedUntil = 0, syncTimer = null, dragDepth = 0, liveSince = null, ids = 0;
  const session = createDraftSession(transport, (state, change) => draw(state, change));
  const element = (tag, className = "", text) => {
    const node = doc.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const nextId = () => `cc-field-${++ids}`;
  const handle = operation => Promise.resolve().then(operation).catch(cause => session.showError(cause));
  // Direct choices record the edit in the same click so the control and the draft never disagree.
  const editNow = operation => { try { operation(); } catch (cause) { session.showError(cause); } };
  function button(label, action, className = "cc-button cc-button--small") {
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
  const mediaInputs = state => state.data?.model?.content?.input.filter(item => ["image", "video", "audio"].includes(item.type)) || [];
  const canEdit = state => Boolean(capabilities.callTool && state.data && state.status === "draft" && !state.uncertain && !(state.busy && state.busy !== "saving") && !readingFile);

  // ---------- Prompt ----------
  const prompt = element("textarea", "composer-prompt-input");
  prompt.rows = 2; prompt.setAttribute("aria-label", "创作描述");
  prompt.placeholder = "描述你想创作的内容，或让 Codex 帮你写…";
  prompt.addEventListener("input", () => handle(() => session.edit({ prompt: prompt.value })));
  prompt.addEventListener("keydown", shortcut);
  prompt.addEventListener("paste", event => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    const inputs = mediaInputs(session.state());
    const accepted = files.filter(file => inputs.some(item => item.type === String(file.type).split("/")[0]) && file.type !== "image/svg+xml");
    if (!accepted.length) {
      if (event.clipboardData?.getData?.("text")) return;
      event.preventDefault();
      handle(() => referenceTypeForFile(files[0], inputs));
      return;
    }
    event.preventDefault();
    handle(() => addFiles(accepted));
  });
  find(".composer-prompt").append(prompt);

  // ---------- Pills ----------
  // A native select keeps the menu outside the iframe; the visible label hugs the chosen value.
  function pill(select, className = "") {
    const wrap = element("label", `chip-select${className ? ` ${className}` : ""}`);
    const label = element("span", "chip-select-label");
    const chevron = element("span", "chip-select-chevron"); chevron.innerHTML = icon("chevron", 12);
    const sync = () => { label.textContent = [...select.querySelectorAll("option")].find(node => node.value === select.value)?.textContent ?? ""; };
    select.addEventListener("change", sync);
    wrap.append(label, chevron, select);
    return { node: wrap, sync };
  }

  // ---------- Model picker ----------
  const modelSelect = element("select", "composer-model-select");
  modelSelect.setAttribute("aria-label", "生成模型");
  modelSelect.addEventListener("change", () => handle(() => session.edit({ model: modelSelect.value || null })));
  const modelPill = pill(modelSelect, "chip-select--model");
  find(".composer-model").append(modelPill.node);
  let catalogKey = "";
  function renderModels(state) {
    const key = JSON.stringify(state.data?.catalog || []);
    if (key !== catalogKey) {
      catalogKey = key; modelSelect.replaceChildren(); option(modelSelect, "", "选择模型");
      const catalog = state.data?.catalog || [];
      if (catalog.every(item => item.category === undefined)) {
        for (const item of catalog) option(modelSelect, item.model, item.title ?? item.model);
      } else {
        for (const category of [...new Set(catalog.map(item => item.category || "other"))]) {
          const group = element("optgroup"); group.label = TYPE_LABELS[category] || "其他";
          for (const item of catalog.filter(entry => (entry.category || "other") === category)) option(group, item.model, item.title ?? item.model);
          modelSelect.append(group);
        }
      }
    }
    if (doc.activeElement !== modelSelect) modelSelect.value = state.local?.model || "";
    modelPill.sync();
  }

  // ---------- Field controls ----------
  function currentOf(state, scope, key, schema) {
    const value = state.local?.[scope]?.[key];
    return value === undefined ? schema.default : value;
  }
  function markInvalid(node, path, cause, label) {
    invalid.set(path, `${label}：${message(cause)}`); node.setAttribute("aria-invalid", "true"); draw(session.state());
  }
  function clearInvalid(node, path) { invalid.delete(path); node.removeAttribute("aria-invalid"); }
  function fieldKind(key, schema) {
    if (schema.type === "boolean") return "switch";
    if (schema.enum) return schema.enum.length <= 4 && schema.enum.every(value => String(value).length <= 10) ? "segments" : "options";
    if ((schema.type === "integer" || schema.type === "number") && Number.isFinite(schema.min) && Number.isFinite(schema.max) && schema.max > schema.min && (schema.type === "number" || schema.max - schema.min <= 120)) return "slider";
    if (schema.type === "string" && schema.dimensions && Array.isArray(schema.examples) && schema.examples.length) return "size";
    if (schema.type === "object") return "json";
    if (schema.type === "string" && /lyrics|prompt/.test(key)) return "textarea";
    return "input";
  }
  function choiceGroup(state, scope, key, schema, values, className, labelId, onPick = () => {}) {
    const group = element("div", className === "composer-segment" ? "composer-segmented" : "composer-options");
    group.setAttribute("role", "radiogroup");
    if (labelId) group.setAttribute("aria-labelledby", labelId);
    const current = currentOf(state, scope, key, schema);
    const choices = schema.optional && schema.default === undefined ? [undefined, ...values] : values;
    const nodes = [];
    for (const value of choices) {
      const choice = element("button", className); choice.type = "button";
      choice.setAttribute("role", "radio");
      choice.setAttribute("aria-checked", String(value === current));
      const ratio = ["ratio", "aspect_ratio", "size"].includes(key) ? aspectOf(value) : null;
      if (ratio) {
        const glyph = element("span", "ratio-glyph");
        glyph.style.setProperty("--r", String(Math.min(2.4, Math.max(0.42, ratio))));
        choice.append(glyph);
      }
      choice.append(element("span", "", valueLabel(key, value)));
      choice.addEventListener("click", () => editNow(() => {
        editField(scope, key, value);
        for (const [node, entry] of nodes) node.setAttribute("aria-checked", String(entry === value));
        onPick(value);
      }));
      nodes.push([choice, value]);
      group.append(choice);
    }
    group.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const index = nodes.findIndex(([node]) => node === doc.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = nodes[(index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + nodes.length) % nodes.length][0];
      next.focus(); next.click();
    });
    return group;
  }
  function slider(state, scope, key, schema, labelId) {
    const wrap = element("div", "composer-slider");
    const input = element("input", "composer-range"); input.type = "range";
    if (labelId) input.setAttribute("aria-labelledby", labelId);
    input.min = String(schema.min); input.max = String(schema.max);
    input.step = schema.type === "integer" ? "1" : String(Math.max((schema.max - schema.min) / 100, Number.EPSILON));
    const current = currentOf(state, scope, key, schema);
    input.value = String(current ?? schema.min);
    const out = element("output", "composer-slider-value");
    const show = value => { out.textContent = schema.type === "number" ? Number(value).toFixed(2) : valueLabel(key, Number(value)); };
    show(input.value);
    const fill = () => input.style.setProperty("--fill", `${((Number(input.value) - schema.min) / (schema.max - schema.min)) * 100}%`);
    fill();
    input.addEventListener("input", () => { show(input.value); fill(); });
    input.addEventListener("change", () => editNow(() => editField(scope, key, parseFieldValue(schema, input.value))));
    wrap.append(input, out);
    return wrap;
  }
  function sizeControl(state, scope, key, schema, labelText, labelId) {
    const wrap = element("div", "composer-size");
    const current = currentOf(state, scope, key, schema);
    const examples = schema.examples.filter(value => typeof value === "string");
    const custom = current !== undefined && !examples.includes(current);
    const input = element("input", "composer-input composer-size-input"); input.type = "text";
    const customChoice = element("button", "composer-option", "自定义"); customChoice.type = "button";
    const group = choiceGroup(state, scope, key, { ...schema, optional: false }, examples, "composer-option", labelId, () => {
      input.hidden = true; customChoice.setAttribute("aria-checked", "false"); clearInvalid(input, input.dataset.field);
    });
    customChoice.setAttribute("role", "radio"); customChoice.setAttribute("aria-checked", String(custom));
    input.placeholder = "宽x高，例如 1280x720"; input.value = custom ? String(current) : ""; input.hidden = !custom;
    input.setAttribute("aria-label", `自定义${labelText}`);
    input.dataset.field = `${scope}.${key}`;
    customChoice.addEventListener("click", () => {
      input.hidden = false; customChoice.setAttribute("aria-checked", "true");
      for (const node of group.querySelectorAll(".composer-option")) if (node !== customChoice) node.setAttribute("aria-checked", "false");
      input.focus();
    });
    input.addEventListener("change", () => {
      try { const value = parseFieldValue(schema, input.value.trim().replace(/\s*[×*]\s*/, "x")); clearInvalid(input, input.dataset.field); editField(scope, key, value); }
      catch (cause) { markInvalid(input, input.dataset.field, cause, labelText); }
    });
    group.append(customChoice);
    wrap.append(group, input);
    return wrap;
  }
  function field(state, scope, key, schema) {
    const labelText = LABELS[key] || key, kind = fieldKind(key, schema), id = nextId();
    const row = element("div", `composer-field composer-field--${kind}`);
    const typed = ["input", "textarea", "json"].includes(kind);
    const label = element(typed ? "label" : "span", "composer-field-label", labelText); label.id = `${id}-label`;
    if (schema.description) label.title = schema.description;
    const control = element("div", "composer-field-control");
    row.append(label, control);
    if (kind === "segments") control.append(choiceGroup(state, scope, key, schema, schema.enum, "composer-segment", label.id));
    else if (kind === "options") control.append(choiceGroup(state, scope, key, schema, schema.enum, "composer-option", label.id));
    else if (kind === "slider") control.append(slider(state, scope, key, schema, label.id));
    else if (kind === "size") control.append(sizeControl(state, scope, key, schema, labelText, label.id));
    else if (kind === "switch") {
      const toggle = element("button", "composer-switch"); toggle.type = "button";
      toggle.setAttribute("role", "switch"); toggle.setAttribute("aria-labelledby", label.id);
      toggle.setAttribute("aria-checked", String(currentOf(state, scope, key, schema) === true));
      toggle.append(element("span", "composer-switch-thumb"));
      toggle.addEventListener("click", () => editNow(() => {
        const next = currentOf(session.state(), scope, key, schema) !== true;
        editField(scope, key, next); toggle.setAttribute("aria-checked", String(next));
      }));
      control.append(toggle);
    } else {
      const input = element(kind === "input" ? "input" : "textarea", kind === "json" ? "composer-input composer-json" : "composer-input");
      if (kind === "input") input.type = ["integer", "number"].includes(schema.type) ? "number" : "text";
      else input.rows = kind === "json" ? 4 : 3;
      if (input.type === "number") { input.step = schema.type === "integer" ? "1" : "any"; if (schema.min !== undefined) input.min = String(schema.min); if (schema.max !== undefined) input.max = String(schema.max); }
      const raw = state.local[scope][key];
      input.value = raw === undefined ? "" : schema.type === "object" ? JSON.stringify(raw, null, 2) : String(raw);
      input.placeholder = schema.default === undefined ? (schema.optional ? "可选" : "必填") : `默认 ${valueLabel(key, schema.default)}`;
      input.dataset.field = `${scope}.${key}`; input.id = id;
      label.setAttribute("for", id);
      const commit = () => {
        try { const value = parseFieldValue(schema, input.value); clearInvalid(input, input.dataset.field); editField(scope, key, value); }
        catch (cause) { markInvalid(input, input.dataset.field, cause, labelText); }
      };
      input.addEventListener(schema.type === "string" && !schema.enum ? "input" : "change", commit);
      control.append(input);
    }
    return row;
  }
  function chip(state, scope, key, schema) {
    let values = null;
    if (schema.enum) values = schema.enum;
    else if (schema.type === "integer" && Number.isFinite(schema.min) && Number.isFinite(schema.max) && schema.max - schema.min <= 31) values = Array.from({ length: schema.max - schema.min + 1 }, (_, index) => schema.min + index);
    else if (schema.dimensions && Array.isArray(schema.examples)) values = schema.examples;
    if (!values?.length) return null;
    const current = currentOf(state, scope, key, schema);
    const select = element("select", "composer-chip"); select.setAttribute("aria-label", LABELS[key] || key); select.title = LABELS[key] || key;
    if (current === undefined || !values.includes(current)) option(select, "", current === undefined ? (LABELS[key] || key) : valueLabel(key, current));
    for (const value of values) option(select, String(value), valueLabel(key, value));
    select.value = current === undefined || !values.includes(current) ? "" : String(current);
    select.addEventListener("change", () => editNow(() => {
      if (select.value === "") return;
      editField(scope, key, schema.type === "integer" ? parseFieldValue(schema, select.value) : values.find(value => String(value) === select.value));
    }));
    const chipPill = pill(select);
    chipPill.sync();
    return chipPill.node;
  }
  function section(title, note = "") {
    const node = element("section", "composer-section");
    const head = element("div", "composer-section-head");
    head.append(element("h2", "composer-section-title", title));
    if (note) head.append(element("span", "composer-section-note", note));
    node.append(head);
    return node;
  }
  function renderForm(state) {
    for (const selector of [".composer-common", ".composer-settings"]) find(selector).replaceChildren();
    chipsRoot.replaceChildren();
    if (!state.data) return;
    const definitions = fieldDefinitions(state.data.model);
    const common = section("设置"), commonFields = element("div", "composer-fields");
    const advanced = element("details", "composer-disclosure cc-details");
    const summary = element("summary", "", "高级设置"); summary.insertAdjacentHTML?.("beforeend", icon("chevron", 14));
    advanced.append(summary);
    const advancedFields = element("div", "composer-fields composer-field-grid"); advanced.append(advancedFields);
    let chips = 0;
    for (const { scope, key, schema } of definitions) {
      const primaryField = PRIMARY_FIELDS.has(key) && schema.type !== "object";
      (primaryField ? commonFields : advancedFields).append(field(state, scope, key, schema));
      if (scope === "parameters" && COMMON_FIELDS.has(key) && chips < 3) {
        const node = chip(state, scope, key, schema);
        if (node) { chipsRoot.append(node); chips++; }
      }
    }
    for (const scope of ["parameters", "meta"]) {
      const keys = new Set(definitions.filter(item => item.scope === scope).map(item => item.key));
      const extra = Object.fromEntries(Object.entries(state.local[scope]).filter(([key]) => !keys.has(key)));
      if (!Object.keys(extra).length) continue;
      const row = element("div", "composer-field composer-field--json");
      const id = nextId(), label = element("label", "composer-field-label", scope === "parameters" ? "其他参数（已保留）" : "其他设置（已保留）"); label.setAttribute("for", id);
      const input = element("textarea", "composer-input composer-json"); input.rows = 4; input.id = id; input.value = JSON.stringify(extra, null, 2);
      input.addEventListener("change", () => {
        try {
          const next = parseFieldValue({ type: "object" }, input.value); clearInvalid(input, `${scope}.extra`);
          const known = Object.fromEntries(Object.entries(session.state().local[scope]).filter(([key]) => keys.has(key)));
          session.edit({ [scope]: { ...known, ...next } });
        } catch (cause) { markInvalid(input, `${scope}.extra`, cause, label.textContent); }
      });
      const control = element("div", "composer-field-control"); control.append(input);
      row.append(label, control); advancedFields.append(row);
    }
    if (commonFields.children.length) { common.append(commonFields); find(".composer-common").append(common); }
    if (advancedFields.children.length) find(".composer-settings").append(advanced);
  }

  // ---------- References ----------
  function roleSelect(item, index, declaration) {
    const select = element("select", "ref-role");
    select.setAttribute("aria-label", `素材 ${index + 1} 的用途`);
    const roles = [...new Set([...(declaration?.roles || []), ...(item.meta?.role ? [item.meta.role] : [])])];
    option(select, "", declaration?.roleRequired ? "选择用途" : "默认用途");
    for (const value of roles) option(select, value, ROLE_LABELS[value] || value);
    select.value = item.meta?.role || "";
    select.addEventListener("change", () => handle(() => {
      const media = clone(session.state().local.media); media[index].meta = { ...media[index].meta };
      if (select.value) media[index].meta.role = select.value; else delete media[index].meta.role;
      session.edit({ media });
    }));
    return select;
  }
  function referenceTile(state, item, index) {
    const declaration = mediaInputs(state).find(entry => entry.type === item.type);
    const tile = element("figure", `ref-tile ref-tile--${item.type}`);
    const frame = element("div", "ref-thumb");
    const source = item.source.type === "url" ? item.source.url : previews.get(item.source.id);
    const name = item.source.type === "file" ? item.source.name : (() => { try { const url = new URL(item.source.url); return url.pathname.split("/").at(-1) || url.hostname; } catch { return item.source.url; } })();
    const fallback = () => {
      frame.replaceChildren(); frame.classList.add("is-fallback");
      const glyph = element("span", "ref-glyph"); glyph.innerHTML = icon(item.type === "image" ? "image" : item.type === "video" ? "video" : "audio", 18);
      frame.append(glyph, element("span", "ref-name", name));
      if (item.source.type === "file") frame.append(element("span", "ref-size", fileSize(item.source.size)));
    };
    if (source && item.type !== "audio") {
      const media = element(item.type === "image" ? "img" : "video", "ref-media");
      if (item.type === "video") { media.muted = true; media.preload = "metadata"; media.playsInline = true; }
      else media.alt = `参考${TYPE_LABELS[item.type]} ${index + 1}`;
      media.addEventListener("error", fallback);
      media.src = source;
      frame.append(media);
      if (item.type === "video") { const badge = element("span", "ref-kind"); badge.innerHTML = icon("video", 12); frame.append(badge); }
    } else fallback();
    tile.append(frame);
    const caption = element("figcaption", "ref-caption");
    if (declaration?.roles?.length || item.meta?.role) {
      const select = roleSelect(item, index, declaration);
      if (declaration?.roleRequired && !item.meta?.role) caption.classList.add("is-missing");
      caption.append(select);
    } else caption.append(element("span", "ref-caption-text", `${TYPE_LABELS[item.type]} ${index + 1}`));
    tile.append(caption);
    const remove = element("button", "ref-remove"); remove.type = "button";
    remove.setAttribute("aria-label", `移除素材 ${index + 1}`); remove.title = "移除";
    remove.innerHTML = icon("close", 12);
    remove.addEventListener("click", () => handle(() => session.edit({ media: session.state().local.media.filter((_, i) => i !== index) })));
    tile.append(remove);
    return tile;
  }
  function renderReferences(state) {
    const target = find(".composer-references"); target.replaceChildren();
    const inputs = mediaInputs(state);
    if (!inputs.length && !state.local?.media.length) return;
    const node = section("参考素材", inputs.length ? `支持${inputs.map(item => TYPE_LABELS[item.type]).join("、")} · 单个不超过 20 MiB` : "");
    if (!canEdit(state)) node.append(element("p", "composer-help", state.local?.media.length ? `这次用了 ${state.local.media.length} 个参考素材，见上方。` : "这次没有使用参考素材。"));
    else if (inputs.length) {
      const row = element("div", "ref-link-row");
      const type = element("select", "composer-input ref-link-type"), role = element("select", "composer-input ref-link-role"), url = element("input", "composer-input ref-link-url");
      type.setAttribute("aria-label", "素材类型"); role.setAttribute("aria-label", "新素材用途");
      url.type = "url"; url.placeholder = "粘贴 HTTPS 素材链接"; url.setAttribute("aria-label", "素材链接");
      for (const input of inputs) option(type, input.type, TYPE_LABELS[input.type]);
      type.hidden = inputs.length < 2;
      const updateType = () => {
        const declaration = inputs.find(item => item.type === type.value); role.replaceChildren();
        option(role, "", declaration.roleRequired ? "选择用途" : "默认用途");
        for (const value of declaration.roles || []) option(role, value, ROLE_LABELS[value] || value);
        role.value = defaultRoleFor(declaration, session.state().local?.media || []) || "";
        role.hidden = !declaration.roles?.length;
      };
      type.addEventListener("change", updateType); updateType();
      const add = button("添加", async () => {
        let parsed;
        try { parsed = new URL(url.value.trim()); } catch { throw new Error("请输入完整的素材链接。"); }
        if (parsed.protocol !== "https:") throw new Error("参考素材需要 HTTPS 链接。");
        const declaration = inputs.find(item => item.type === type.value);
        if (declaration.roleRequired && !role.value) throw new Error("请先选择素材用途。");
        await session.addReference({ type: type.value, url: parsed.href, ...(role.value ? { role: role.value } : {}) });
        url.value = "";
      }, "cc-button cc-button--small");
      row.append(type, role, url, add);
      node.append(row);
      node.append(element("p", "composer-help", "也可以把文件拖进卡片，或在描述框里粘贴图片。本地素材在生成时上传到所选空间。"));
    }
    target.append(node);
  }

  // ---------- Stage ----------
  function stageFrame(state) {
    const category = state.data?.model?.category;
    const shape = shapeOf(state.data?.model, state.local?.parameters);
    const canvas = element("div", "cc-canvas composer-canvas");
    const frame = element("div", "cc-frame");
    if (category === "audio" || category === "music" || category === "speech") {
      frame.classList.add("cc-frame--audio"); frame.innerHTML = icon("audio", 18);
      frame.append(element("span", "cc-frame-label", KIND_LABELS[category]));
    } else if (shape.ratio && (category === "image" || category === "video")) {
      frame.style.setProperty("--frame-ratio", String(shape.ratio));
      frame.innerHTML = icon(category === "video" ? "video" : "image", 18);
      frame.append(element("span", "cc-frame-label", shape.label));
    } else {
      frame.classList.add("cc-frame--free");
      frame.append(element("span", "cc-frame-label", shape.label || (state.data?.model ? "作品会出现在这里" : "选择模型后开始")));
    }
    canvas.append(frame);
    if (canEdit(state) && mediaInputs(state).length) canvas.append(element("p", "composer-canvas-hint", `拖入或粘贴${mediaInputs(state).map(item => TYPE_LABELS[item.type]).join("、")}作为参考`));
    return canvas;
  }
  function referenceStrip(state) {
    const canvas = element("div", "cc-canvas composer-canvas composer-canvas--refs");
    const strip = element("div", "ref-strip");
    state.local.media.forEach((item, index) => strip.append(referenceTile(state, item, index)));
    canvas.append(strip);
    return canvas;
  }
  function drawStage(state) {
    const generation = state.data?.generation, layout = composerLayoutMode(hostContext);
    const signature = JSON.stringify(generation
      ? ["result", generation.id, generation.status, generation.media, generation.startedAt, layout, capabilities.openLink, state.data?.model?.title]
      : ["draft", state.local?.media, shapeOf(state.data?.model, state.local?.parameters), state.data?.model?.category, canEdit(state), layout, Boolean(state.data), [...previews.keys()]]);
    if (signature === stageKey) return;
    stageKey = signature;
    stageView?.destroy(); stageView = null; stage.replaceChildren();
    if (generation) {
      if (LIVE_GENERATION.has(generation.status)) {
        if (!liveSince) liveSince = new Date().toISOString();
        const shape = shapeOf(state.data.model, state.data.draft.parameters);
        stageView = createProgressView(doc, { status: generation.status, since: generation.startedAt || generation.createdAt || liveSince, ratio: shape.ratio, model: state.data.model?.title || generation.model || "", frameHeight: layout === "expanded" ? "220px" : "150px" });
        stage.append(stageView.node);
        return;
      }
      liveSince = null;
      if (generation.media.length) {
        stageView = createMediaView(doc, generation, {
          label: state.data.draft.title || "Cohub 作品",
          maxHeight: layout === "expanded" ? "58vh" : "440px",
          openLink: capabilities.openLink && typeof transport.openLink === "function" ? url => handle(async () => { const result = await transport.openLink(url); if (result?.isError) throw new Error("链接未能打开，地址保留在详情中。"); }) : null,
        });
        stage.append(stageView.node);
        return;
      }
      const canvas = element("div", "cc-canvas composer-canvas");
      const frame = element("div", "cc-frame cc-frame--free cc-frame--failed");
      frame.innerHTML = icon(generation.status === "failed" ? "alert" : "check", 18);
      frame.append(element("span", "cc-frame-label", generation.status === "failed" ? "这次没有生成成功" : "Cohub 未返回可预览的素材"));
      canvas.append(frame); stage.append(canvas);
      return;
    }
    stage.append(state.local?.media.length ? referenceStrip(state) : stageFrame(state));
  }

  // ---------- Files ----------
  function openPicker() {
    const state = session.state();
    if (!canEdit(state)) return;
    fileInput.accept = mediaInputs(state).map(item => `${item.type}/*`).join(",");
    fileInput.value = "";
    fileInput.click();
  }
  async function addFiles(files) {
    for (const file of files) {
      const state = session.state();
      if (!canEdit(state)) throw new Error("现在不能添加素材。");
      const inputs = mediaInputs(state), type = referenceTypeForFile(file, inputs);
      const role = defaultRoleFor(inputs.find(item => item.type === type), state.local.media);
      let reference;
      readingFile = true; draw(session.state());
      try { reference = await readReferenceFile(file, type); }
      finally { readingFile = false; draw(session.state()); }
      const before = session.state().data.draft.media.length;
      await session.addReference({ ...reference, ...(role ? { role } : {}) });
      const added = session.state().data?.draft.media[before];
      if (added?.source.type === "file" && type === "image") {
        previews.set(added.source.id, `data:${reference.mimeType};base64,${reference.base64}`);
        stageKey = ""; mediaFormKey = ""; draw(session.state());
      }
    }
  }
  attach.setAttribute("aria-label", "添加参考素材"); attach.title = "添加参考素材";
  attach.addEventListener("click", openPicker);
  fileInput.hidden = true; fileInput.multiple = true; fileInput.tabIndex = -1;
  fileInput.addEventListener("change", () => { const files = [...(fileInput.files || [])]; if (files.length) handle(() => addFiles(files)); });
  const draggingFiles = event => [...(event.dataTransfer?.types || [])].includes("Files");
  function dragEnter(event) {
    if (!draggingFiles(event)) return;
    event.preventDefault(); dragDepth += 1;
    shell.classList.toggle("is-dragging", canEdit(session.state()) && mediaInputs(session.state()).length > 0);
  }
  function dragOver(event) {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = canEdit(session.state()) && mediaInputs(session.state()).length ? "copy" : "none";
  }
  function dragLeave(event) {
    if (!draggingFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) shell.classList.remove("is-dragging");
  }
  function drop(event) {
    if (!draggingFiles(event)) return;
    event.preventDefault(); dragDepth = 0; shell.classList.remove("is-dragging");
    const files = [...(event.dataTransfer?.files || [])];
    if (!mediaInputs(session.state()).length) { session.showError(new Error("当前模型不接受参考素材。")); return; }
    if (files.length) handle(() => addFiles(files));
  }
  for (const [name, listener] of [["dragenter", dragEnter], ["dragover", dragOver], ["dragleave", dragLeave], ["drop", drop]]) shell.addEventListener(name, listener);

  // ---------- Result details ----------
  let detailsKey = "";
  function drawResultDetails(state) {
    const target = find(".composer-result-details"), generation = state.data?.generation;
    const key = JSON.stringify(generation ? [generation.id, generation.status, generation.billing, generation.finishedAt, generation.model] : null);
    if (key === detailsKey) return;
    detailsKey = key; target.replaceChildren();
    if (!generation || LIVE_GENERATION.has(generation.status)) return;
    const details = element("details", "cc-details composer-result-disclosure");
    const summary = element("summary", "", "作品详情"); summary.insertAdjacentHTML?.("beforeend", icon("chevron", 14));
    const list = element("dl", "details-list");
    const row = (label, value, mono = false) => list.append(element("dt", "", label), element("dd", mono ? "is-mono" : "", value));
    if (generation.model) row("模型", generation.model, true);
    if (generation.billing) row("费用记录", `$${generation.billing.amountUsd.toLocaleString("en-US", { maximumFractionDigits: 6 })} USD · ${generation.billing.status}`, true);
    const took = elapsedLabel(generation.startedAt, generation.finishedAt);
    if (took) row("生成用时", took);
    row("生成任务", generation.id, true);
    row("草稿", state.data.draft.id, true);
    const content = element("div", "details-content"); content.append(list);
    details.append(summary, content); target.append(details);
  }

  // ---------- Feedback ----------
  let feedbackKey = "";
  function drawFeedback(state) {
    const notices = [], actions = [];
    const add = (text, kind = "error") => { notices.push([text, kind]); };
    const compact = composerLayoutMode(hostContext) === "inline";
    if (!capabilities.callTool) add("当前聊天不支持在卡片里保存或生成，可在对话中继续。", "hint");
    if (displayError) add(displayError);
    if (state.error) add(state.error, state.conflict ? "warn" : "error");
    const uncertain = state.uncertain || state.status === "unknown";
    if (state.data?.draft.error && state.data.draft.error !== state.error && !uncertain) add(state.data.draft.error);
    if (uncertain) add(`${state.data?.draft.error ? `${state.data.draft.error.replace(/[。.]?$/, "。")}` : "提交结果尚未确认。"}为避免重复生成和扣费，请先让 Codex 查询原任务。`, "warn");
    if (state.data?.generation?.status === "failed") add(state.data.generation.error || "这次生成未成功，Cohub 没有返回具体原因。");
    for (const value of invalid.values()) add(value);
    const errors = state.status === "draft" ? state.data?.validation.errors || [] : [];
    const missing = errors.filter(item => item.kind === "missing"), wrong = errors.filter(item => item.kind !== "missing");
    for (const item of wrong) add(`${pathLabel(item.path)}：${item.message}`);
    if (compact && (invalid.size || wrong.some(item => !item.path.startsWith("prompt")))) add("点“展开编辑”可以修改这些设置。", "hint");
    for (const text of [...new Set(missing.map(missingHint))].slice(0, 3)) add(text, "hint");
    if (state.status === "draft") for (const limitation of state.data?.limitations || []) add(limitation, "hint");
    if (state.contextError) add(state.contextError, "hint");
    if (state.conflict && state.dirty.length) {
      actions.push("remote");
      if (state.conflict.draft.status === "draft") actions.push("local");
    } else if (state.error && state.dirty.length && !state.busy && state.status === "draft") actions.push("retry");
    // Rebuild only when the content changes, so a click on one of these buttons is never detached mid-press.
    const key = JSON.stringify([notices, actions]);
    if (key === feedbackKey) return;
    feedbackKey = key;
    feedback.replaceChildren();
    for (const [text, kind] of notices) {
      const node = element("p", `composer-notice composer-notice--${kind} cc-notice cc-notice--${kind}`);
      node.innerHTML = icon(kind === "error" || kind === "warn" ? "alert" : "info", 14);
      node.append(element("span", "cc-notice-text", text));
      if (kind === "error") node.setAttribute("role", "alert");
      feedback.append(node);
    }
    if (actions.length) {
      const row = element("div", "composer-conflict-actions");
      const labels = { remote: "使用最新内容", local: "保留我的修改", retry: "重试保存" };
      const run = { remote: () => { invalid.clear(); session.resolveConflict("remote"); }, local: () => session.resolveConflict("local"), retry: () => session.save() };
      for (const name of actions) row.append(button(labels[name], run[name], `cc-button cc-button--small${name === "local" ? " cc-button--primary" : ""}`));
      feedback.append(row);
    }
    feedback.hidden = feedback.children.length === 0;
  }

  // ---------- Draw ----------
  function draw(state, change = {}) {
    if (destroyed) return;
    const layout = composerLayoutMode(hostContext), compact = layout === "inline";
    const revision = state.data?.draft.revision, draftId = state.data?.draft.id;
    if (change.origin === "remote" && lastSeen?.id === draftId && revision > lastSeen.revision && state.status === "draft" && !state.busy) {
      syncedUntil = Date.now() + 2800; box.classList.add("is-synced");
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => { syncTimer = null; box.classList.remove("is-synced"); draw(session.state()); }, 2800);
    }
    if (state.data) lastSeen = { id: draftId, revision };
    const nextKey = state.data ? JSON.stringify([draftId, state.data.model?.model, fieldDefinitions(state.data.model)]) : "empty";
    const editingNow = state.editing || Boolean(root.contains(doc.activeElement) && doc.activeElement?.matches?.("input, textarea, select"));
    if (nextKey !== formKey || (change.replace && !editingNow)) { formKey = nextKey; renderForm(state); }
    if (state.local && doc.activeElement !== prompt && prompt.value !== state.local.prompt) prompt.value = state.local.prompt;
    renderModels(state);
    const nextMediaKey = JSON.stringify([state.data?.model?.model, state.local?.media, mediaInputs(state), canEdit(state)]);
    if (nextMediaKey !== mediaFormKey) { mediaFormKey = nextMediaKey; renderReferences(state); }
    drawStage(state); drawResultDetails(state); drawFeedback(state);

    const generation = state.data?.generation;
    const generating = LIVE_GENERATION.has(generation?.status);
    const terminal = state.status === "submitted" && generation && !generating;
    const category = state.data?.model?.category;
    find(".composer-kind").textContent = state.data ? (KIND_LABELS[category] || "创作") : "";
    const [statusText, tone] = state.uncertain ? ["待确认", "warn"]
      : state.busy === "submitting" || state.status === "submitting" ? ["正在提交", "live"]
      : generating ? [generation.status === "pending" ? "排队中" : "正在生成", "live"]
      : terminal ? (generation.status === "failed" ? ["生成失败", "error"] : ["已完成", "done"])
      : state.status === "submitted" ? ["已提交", "live"]
      : state.conflict ? ["有新版本", "warn"]
      : state.data ? ["草稿", "quiet"] : ["等待草稿", "quiet"];
    find(".composer-status-label").textContent = statusText;
    find(".composer-status").dataset.tone = tone;
    find(".composer-status").hidden = tone === "quiet";
    const took = terminal ? elapsedLabel(generation.startedAt, generation.finishedAt) : null;
    find(".composer-save-state").textContent = readingFile ? "正在读取文件…" : state.busy === "reference" ? "正在添加素材…" : state.busy === "saving" ? "正在保存…" : state.dirty.length ? "尚未保存" : Date.now() < syncedUntil ? "已同步最新内容" : !state.data ? "" : state.status === "draft" ? "已保存" : terminal ? (took ? `用时 ${took}` : "") : "";

    const locked = !canEdit(state);
    for (const selector of [".composer-editor", ".composer-panel", ".composer-stage"]) {
      for (const control of find(selector).querySelectorAll("input, textarea, select, button")) {
        if (control === primary || ["media-open", "audio-toggle", "audio-progress"].some(name => control.classList.contains(name))) continue;
        control.disabled = locked;
      }
    }
    if (invalid.size) modelSelect.disabled = true;
    const accepts = mediaInputs(state).length > 0;
    attach.hidden = !accepts || locked;
    shell.dataset.locked = String(locked);
    shell.dataset.status = terminal ? generation.status : generating ? "running" : state.status || "empty";

    const price = state.data?.model ? priceSummary(state.data.model.pricing, state.data.model.parameters, state.local?.parameters) : null;
    if (terminal && generation.billing) {
      priceNode.textContent = `费用 $${generation.billing.amountUsd.toLocaleString("en-US", { maximumFractionDigits: 4, minimumFractionDigits: 2 })}`;
      priceNode.title = "这次生成的记账金额";
    } else if (price && !terminal) {
      priceNode.textContent = price.estimate || price.unit;
      priceNode.title = `参考价 ${price.unit}${state.data.model.pricing.note ? `（${state.data.model.pricing.note}）` : ""}，实际费用以 Cohub 记录为准`;
    } else { priceNode.textContent = ""; priceNode.title = ""; }
    priceNode.hidden = !priceNode.textContent;

    const submitting = state.busy === "submitting" || state.status === "submitting";
    primaryLabel.textContent = terminal ? "再创作" : submitting ? "正在提交…" : state.status === "submitted" ? "生成中…" : "生成";
    kbd.textContent = isMac() ? "⌘↵" : "Ctrl ↵";
    kbd.hidden = terminal || state.status !== "draft" || submitting;
    primary.title = terminal ? "用同样的设置开一份新草稿" : state.status === "draft" ? `生成（${isMac() ? "⌘" : "Ctrl"} + Enter）` : "";
    primary.disabled = !capabilities.callTool || !state.data || Boolean(state.busy && state.busy !== "saving") || readingFile || state.uncertain || Boolean(state.conflict) || invalid.size > 0 || (!terminal && (state.status !== "draft" || !state.local?.model || state.data.validation.errors.length > 0));
    primary.classList.toggle("is-busy", submitting);

    shell.dataset.layout = layout;
    for (const selector of [".composer-common", ".composer-settings", ".composer-references"]) find(selector).hidden = compact;
    find(".composer-panel").hidden = compact;
    chipsRoot.hidden = !compact || !chipsRoot.children.length;
    prompt.rows = compact ? 2 : 4;
    // Rebuilding a button between mousedown and mouseup would swallow the click; only touch it when its label changes.
    if (displayButton.dataset.mode !== layout) {
      displayButton.dataset.mode = layout;
      displayButton.innerHTML = icon(compact ? "expand" : "back", 14);
      displayButton.append(element("span", "", compact ? "展开编辑" : "返回聊天"));
    }
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
      if (response.mode !== target) throw new Error("宿主未切换到请求的显示模式。");
    } catch (cause) {
      if (!destroyed) displayError = `${target === "fullscreen" ? "无法展开编辑" : "无法返回聊天"}：${message(cause)}`;
    } finally { if (!destroyed) { changingDisplayMode = false; stageKey = ""; draw(session.state()); } }
  });
  primary.addEventListener("click", () => handle(() => session.state().status === "submitted" ? session.recreate() : session.submit()));
  function shortcut(event) {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (primary.disabled || session.state().status !== "draft") return;
    handle(() => session.submit());
  }
  function rootShortcut(event) { if (!event.defaultPrevented) shortcut(event); }
  function focusChanged() {
    queueMicrotask(() => {
      if (destroyed) return;
      session.setEditing(invalid.size > 0 || Boolean(root.contains(doc.activeElement) && doc.activeElement?.matches("input, textarea, select")));
    });
  }
  function visibilityChanged() { session.setVisible(!doc.hidden); }
  root.addEventListener("focusin", focusChanged); root.addEventListener("focusout", focusChanged); root.addEventListener("keydown", rootShortcut);
  doc.addEventListener("visibilitychange", visibilityChanged);
  draw(session.state()); session.setVisible(!doc.hidden);
  return {
    render(result) { try { session.receive(result); } catch (cause) { session.showError(cause); } },
    showError: cause => session.showError(cause),
    setCapabilities(value) { capabilities = value; stageKey = ""; session.setCapabilities(value); },
    setHostContext(context) { hostContext = { ...hostContext, ...context }; if (["light", "dark"].includes(context.theme)) root.dataset.theme = context.theme; draw(session.state()); },
    destroy() {
      destroyed = true; session.destroy(); stageView?.destroy(); clearTimeout(syncTimer);
      previews.clear();
      root.removeEventListener("focusin", focusChanged); root.removeEventListener("focusout", focusChanged); root.removeEventListener("keydown", rootShortcut);
      for (const [name, listener] of [["dragenter", dragEnter], ["dragover", dragOver], ["dragleave", dragLeave], ["drop", drop]]) shell.removeEventListener(name, listener);
      doc.removeEventListener("visibilitychange", visibilityChanged);
    },
  };
}
