import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftSession, fieldDefinitions, parseFieldValue, readComposerResult, readReferenceFile } from '../web/composer.js';
import * as composer from '../web/composer.js';

const model = { model: 'example-image', title: 'Example image', category: 'image', content: { input: [{ type: 'text', required: true }, { type: 'image', sources: ['url'], roles: ['first_frame', 'last_frame'] }] }, parameters: { duration: { type: 'integer', optional: true, min: 1, max: 15, default: 5 } }, meta: { fields: { lyrics: { type: 'string', optional: true }, settings: { type: 'object', optional: true } } } };
const initial = () => ({ kind: 'composer', draft: { id: 'draft-1', spaceId: 'space-1', revision: 1, title: '创作', model: model.model, prompt: 'Original', media: [], parameters: {}, meta: {}, status: 'draft' }, model, catalog: [{ model: model.model, title: model.title, category: 'image' }], generation: null, validation: { errors: [] }, limitations: [] });
const result = data => ({ structuredContent: structuredClone(data) });

test('catalog entries can use their model ID when an optional display title is absent', () => {
  const data = initial(); data.catalog = [{ model: model.model }];
  assert.deepEqual(readComposerResult(result(data)).catalog, data.catalog);
  data.catalog[0].title = null;
  assert.throws(() => readComposerResult(result(data)), /模型列表格式/);
});
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function server() {
  let data = initial(); const calls = [];
  return {
    get data() { return data; }, calls,
    async callTool(name, args) {
      calls.push([name, structuredClone(args)]);
      if (name === 'read_generation_draft') return result(data);
      assert.equal(args.baseRevision, data.draft.revision, 'every mutation uses the latest revision');
      if (name === 'update_generation_draft') data = { ...data, draft: { ...data.draft, ...args.patch, revision: data.draft.revision + 1 } };
      else if (name === 'submit_generation') data = { ...data, draft: { ...data.draft, status: 'submitted', taskRunId: 'task-1', revision: data.draft.revision + 1 } };
      else throw new Error(`Unexpected tool ${name}`);
      return result(data);
    },
    replace(next) { data = structuredClone(next); },
  };
}

test('official fields retain their scopes and reject bad typed input', () => {
  assert.deepEqual(fieldDefinitions(model).map(({ scope, key }) => [scope, key]), [['parameters', 'duration'], ['meta', 'lyrics'], ['meta', 'settings']]);
  assert.equal(parseFieldValue(model.parameters.duration, ''), undefined);
  assert.equal(parseFieldValue(model.parameters.duration, '12'), 12);
  for (const value of ['0', '16', '2.5', 'oops']) assert.throws(() => parseFieldValue(model.parameters.duration, value));
  assert.deepEqual(parseFieldValue({ type: 'object' }, '{"speaker":{"weight":0.5}}'), { speaker: { weight: 0.5 } });
  for (const value of ['[1]', 'null', '{']) assert.throws(() => parseFieldValue({ type: 'object' }, value));
  assert.equal(parseFieldValue({ type: 'boolean' }, 'false'), false);
});

test('shared edits preserve local text and merge only explicitly retained fields against the newest revision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = server(), session = createDraftSession(backend); session.receive(result(backend.data));
  session.edit({ prompt: 'My unfinished input' });
  const remote = initial(); remote.draft.revision = 2; remote.draft.prompt = 'Agent edit'; remote.draft.parameters = { duration: 8 }; backend.replace(remote);
  session.receive(result(remote));
  assert.equal(session.state().local.prompt, 'My unfinished input');
  assert.equal(session.state().conflict.draft.revision, 2);
  await assert.rejects(() => session.submit(), /冲突/);
  assert.equal(backend.calls.filter(([name]) => name === 'submit_generation').length, 0);
  session.resolveConflict('local'); await session.save();
  assert.equal(backend.data.draft.prompt, 'My unfinished input');
  assert.deepEqual(backend.data.draft.parameters, { duration: 8 });
  assert.deepEqual(backend.calls.at(-1), ['update_generation_draft', { draftId: 'draft-1', baseRevision: 2, patch: { prompt: 'My unfinished input' } }]);
  session.destroy();
});

test('typing during an outstanding save is saved again before the latest copy is submitted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = server(); let release, first = true;
  const session = createDraftSession({ callTool: async (name, args) => {
    if (name === 'update_generation_draft' && first) { first = false; await new Promise(resolve => { release = resolve; }); }
    return backend.callTool(name, args);
  } });
  session.receive(result(backend.data)); session.edit({ prompt: 'First input' }); const saving = session.save();
  session.edit({ prompt: 'Latest input' }); const submitting = session.submit(); release();
  await saving; await submitting;
  assert.equal(backend.data.draft.prompt, 'Latest input');
  assert.equal(backend.calls.filter(([name]) => name === 'update_generation_draft').length, 2);
  assert.equal(backend.calls.find(([name]) => name === 'submit_generation')[1].baseRevision, 3);
  session.destroy();
});

test('failed saves preserve input and cannot fall through to submission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], session = createDraftSession({ callTool: async name => { calls.push(name); throw new Error('revision conflict'); } });
  session.receive(result(initial())); session.edit({ prompt: 'Keep this input' });
  await assert.rejects(() => session.submit(), /revision conflict/);
  assert.deepEqual(calls, ['update_generation_draft']);
  assert.equal(session.state().local.prompt, 'Keep this input');
  assert.deepEqual(session.state().dirty, ['prompt']); session.destroy();
});

test('double clicks create one submit request and submitted drafts cannot submit again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = server(); let release;
  const session = createDraftSession({ callTool: async (name, args) => {
    if (name === 'submit_generation') await new Promise(resolve => { release = resolve; });
    return backend.callTool(name, args);
  } });
  session.receive(result(backend.data));
  const first = session.submit(), second = session.submit(); await flush(); release(); await Promise.all([first, second]);
  assert.equal(backend.calls.filter(([name]) => name === 'submit_generation').length, 1);
  await assert.rejects(() => session.submit(), /不能再次生成/);
  assert.equal(backend.calls.filter(([name]) => name === 'submit_generation').length, 1); session.destroy();
});

test('an unconfirmed submission blocks retries instead of risking a second charge', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let submits = 0;
  const session = createDraftSession({ callTool: async name => {
    if (name === 'read_generation_draft') return result(initial());
    submits++; throw new Error('connection lost after request');
  } });
  session.receive(result(initial())); await assert.rejects(() => session.submit(), /connection lost/);
  assert.equal(session.state().uncertain, true);
  await assert.rejects(() => session.submit(), /不能再次生成/); assert.equal(submits, 1); session.destroy();
});

test('closing the card before its final read completes prevents a later submit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release, submits = 0;
  const session = createDraftSession({ callTool: async name => {
    if (name === 'read_generation_draft') { await new Promise(resolve => { release = resolve; }); return result(initial()); }
    submits++; const data = initial(); data.draft.status = 'submitted'; data.draft.revision++; return result(data);
  } });
  session.receive(result(initial())); const pending = session.submit(); await flush(); session.destroy(); release();
  await assert.rejects(() => pending, /关闭/); assert.equal(submits, 0);
});

test('editing defers remote replacement, visibility pauses reads, and destroy stops them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = server(), session = createDraftSession(backend); session.receive(result(backend.data));
  session.setEditing(true); const remote = initial(); remote.draft.revision = 2; remote.draft.prompt = 'Remote newest';
  backend.replace(remote); session.receive(result(remote)); assert.equal(session.state().local.prompt, 'Original');
  session.setEditing(false); assert.equal(session.state().local.prompt, 'Remote newest');
  session.setVisible(false); t.mock.timers.tick(12000); assert.equal(backend.calls.length, 0);
  session.setVisible(true); t.mock.timers.tick(4000); await flush(); assert.equal(backend.calls.length, 1);
  session.destroy(); t.mock.timers.tick(12000); assert.equal(backend.calls.length, 1);
});

test('draft context is published only when supported and never starts a chat reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const notes = [], session = createDraftSession({ callTool: async () => result(initial()), updateModelContext: async note => { notes.push(JSON.parse(note)); return {}; } });
  session.receive(result(initial())); await flush(); assert.deepEqual(notes, []);
  session.setCapabilities({ callTool: true, updateModelContext: true }); await flush();
  assert.deepEqual(notes, [{ cohubDraft: 'draft-1', revision: 1, model: 'example-image', status: 'draft', prompt: 'Original' }]);
  session.receive(result(initial())); await flush(); assert.equal(notes.length, 1); session.destroy();
});

test('host context failures do not undo a saved draft and are still reported', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = createDraftSession({ callTool: async () => result(initial()), updateModelContext: () => { throw new Error('host unavailable'); } });
  session.receive(result(initial()));
  assert.doesNotThrow(() => session.setCapabilities({ callTool: true, updateModelContext: true }));
  await flush(); assert.equal(session.state().data.draft.revision, 1);
  assert.match(session.state().contextError, /host unavailable/); session.destroy();
});

test('weighted media and explicit upstream limitations remain visible in the shared draft', () => {
  const data = initial(); data.draft.media = [{ type: 'audio', source: { type: 'url', url: 'https://example.org/voice.mp3' }, meta: { weight: 0.6 } }]; data.limitations = ['Weighted blend is unavailable through this CLI'];
  const received = readComposerResult(result(data));
  assert.equal(received.draft.media[0].meta.weight, 0.6);
  assert.deepEqual(received.limitations, data.limitations);
});

test('same-revision task progress replaces the result and a terminal result stops polling', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let reads = 0;
  const session = createDraftSession({ callTool: async () => { reads++; throw new Error('unexpected read'); } });
  const data = initial(); data.draft.status = 'submitted'; data.draft.taskRunId = 'task-1';
  data.generation = { kind: 'generation', id: 'task-1', spaceId: 'space-1', title: '作品', status: 'running', media: [], checkedAt: '2026-10-10T01:00:00Z' };
  session.receive(result(data)); data.generation.status = 'completed'; data.generation.media = [{ type: 'image', url: 'https://example.org/result.png' }];
  session.receive(result(data)); assert.equal(session.state().data.generation.media[0].url, 'https://example.org/result.png');
  t.mock.timers.tick(16000); assert.equal(reads, 0); session.destroy();
});

test('browser files exceeding 20 MiB or unsafe media are rejected before reading', async () => {
  await assert.rejects(() => readReferenceFile({ size: 20 * 1024 * 1024 + 1, type: 'image/png', name: 'large.png' }, 'image'), /20 MiB/);
  await assert.rejects(() => readReferenceFile({ size: 10, type: 'image/svg+xml', name: 'active.svg' }, 'image'), /请选择/);
  await assert.rejects(() => readReferenceFile({ size: 0, type: 'audio/mpeg', name: 'empty.mp3' }, 'audio'), /空文件/);
});

// Minimal DOM for the actual view's mode controls; draft behavior is tested above.
class ViewElement {
  constructor(tagName, ownerDocument) {
    Object.assign(this, { tagName, ownerDocument, children: [], dataset: {}, attributes: {}, className: '', hidden: false, disabled: false, _text: '', _value: undefined, listeners: new Map() });
    this.classList = { add: (...names) => { this.className += ` ${names.join(' ')}`; } };
  }
  set innerHTML(html) {
    this.replaceChildren(); const stack = [this];
    for (const token of html.matchAll(/<\/?([a-z0-9]+)\b([^>]*)>|([^<]+)/g)) {
      if (token[3]) { stack.at(-1)._text += token[3]; continue; }
      if (token[0].startsWith('</')) { stack.pop(); continue; }
      const node = new ViewElement(token[1], this.ownerDocument);
      for (const [, key, value] of token[2].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(key, value);
      stack.at(-1).append(node);
      if (!['input', 'img', 'br'].includes(node.tagName)) stack.push(node);
    }
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set value(value) { this._value = value; }
  get value() { return this._value ?? (this.tagName === 'select' ? this.querySelector('option')?.value : undefined) ?? ''; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; if (key === 'class') this.className = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  fire(name) { return this.listeners.get(name)?.(); }
  click() { if (!this.disabled) return this.fire('click'); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector) { return selector.split(',').some(part => { part = part.trim(); return part.startsWith('.') ? this.className.split(/\s+/).includes(part.slice(1)) : this.tagName === part; }); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
}
function mountComposerView(transport = {}) {
  const doc = { hidden: false, activeElement: null, createElement: tag => new ViewElement(tag, doc), addEventListener() {}, removeEventListener() {} };
  const root = new ViewElement('main', doc), backend = server();
  const view = composer.mountComposer(root, { callTool: (...args) => backend.callTool(...args), ...transport });
  view.setCapabilities({ callTool: true, expand: true }); view.render(result(initial()));
  return { view, root, backend, find: selector => root.querySelector(selector) };
}

test('layout follows actual host display mode, never available width', () => {
  assert.equal(composer.composerLayoutMode(), 'inline');
  assert.equal(composer.composerLayoutMode({ displayMode: 'inline', containerDimensions: { width: 1600 } }), 'inline');
  assert.equal(composer.composerLayoutMode({ displayMode: 'fullscreen', containerDimensions: { width: 320 } }), 'expanded');
  assert.equal(composer.composerLayoutMode({ displayMode: 'pip' }), 'inline');
});

test('default inline form is compact and host context switches the same inputs', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { view, find } = mountComposerView(); t.after(() => view.destroy());
  const prompt = find('.composer-prompt-input');
  assert.equal(find('.cohub-composer').dataset.layout, 'inline');
  assert.equal(prompt.rows, 2);
  for (const selector of ['.composer-common', '.composer-settings', '.composer-references']) assert.equal(find(selector).hidden, true);
  view.setHostContext({ displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] });
  assert.equal(find('.cohub-composer').dataset.layout, 'expanded');
  assert.equal(find('.composer-prompt-input'), prompt);
  assert.equal(prompt.rows, 4);
  for (const selector of ['.composer-common', '.composer-settings', '.composer-references']) assert.equal(find(selector).hidden, false);
  assert.equal(find('.composer-display-mode').textContent, '返回聊天');
  view.setHostContext({ theme: 'dark' });
  assert.equal(find('.cohub-composer').dataset.layout, 'expanded', 'theme notifications do not reset display mode');
});

test('expansion waits for host confirmation and returning retains unsaved text in the same draft', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = []; let release;
  const { view, find, backend } = mountComposerView({ requestDisplayMode: mode => { requests.push(mode); return new Promise(resolve => { release = resolve; }); } }); t.after(() => view.destroy());
  view.setHostContext({ displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] });
  const prompt = find('.composer-prompt-input'); prompt.value = 'Keep my unfinished description'; prompt.fire('input'); await flush();
  find('.composer-display-mode').click(); await flush();
  assert.deepEqual(requests, ['fullscreen']);
  assert.equal(find('.cohub-composer').dataset.layout, 'inline');
  assert.equal(find('.composer-display-mode').disabled, true);
  release({ mode: 'fullscreen' }); await flush();
  assert.equal(find('.cohub-composer').dataset.layout, 'expanded');
  assert.equal(find('.composer-prompt-input'), prompt);
  assert.equal(prompt.value, 'Keep my unfinished description');
  find('.composer-display-mode').click(); await flush();
  assert.deepEqual(requests, ['fullscreen', 'inline']);
  release({ mode: 'inline' }); await flush();
  assert.equal(find('.cohub-composer').dataset.layout, 'inline');
  assert.equal(find('.composer-prompt-input'), prompt);
  t.mock.timers.tick(650); await flush();
  assert.equal(backend.data.draft.id, 'draft-1');
  assert.equal(backend.data.draft.prompt, 'Keep my unfinished description');
  assert.equal(backend.calls.filter(([name]) => name === 'submit_generation').length, 0);
});

test('unsupported expansion and return are disabled without making a host request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [], { view, find } = mountComposerView({ requestDisplayMode: async mode => { requests.push(mode); return { mode }; } }); t.after(() => view.destroy());
  view.setCapabilities({ callTool: true, expand: false });
  assert.equal(find('.composer-display-mode').disabled, true); find('.composer-display-mode').click(); await flush();
  view.setHostContext({ displayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] });
  assert.equal(find('.composer-display-mode').textContent, '返回聊天');
  assert.equal(find('.composer-display-mode').disabled, true); find('.composer-display-mode').click(); await flush();
  assert.deepEqual(requests, []);
});

test('failed, invalid, or declined expansion stays honest and preserves editable input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const response of [() => { throw new Error('Panel unavailable'); }, () => ({ displayMode: 'fullscreen' }), () => ({ mode: 'inline' })]) {
    const { view, find } = mountComposerView({ requestDisplayMode: response });
    const prompt = find('.composer-prompt-input'); prompt.value = 'Keep this text'; prompt.fire('input'); await flush();
    find('.composer-display-mode').click(); await flush();
    assert.equal(find('.cohub-composer').dataset.layout, 'inline');
    assert.equal(find('.composer-prompt-input'), prompt);
    assert.equal(prompt.value, 'Keep this text');
    assert.match(find('.composer-feedback').textContent, /无法展开|未能展开/);
    assert.doesNotMatch(find('.composer-feedback').textContent, /重试保存/);
    assert.equal(find('.composer-display-mode').disabled, false);
    view.destroy();
  }
});

test('inline validation points to expanded editing while still blocking invalid generation', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { view, find } = mountComposerView(); t.after(() => view.destroy());
  const data = initial(); data.validation.errors = [{ path: 'parameters.duration', message: '时长不支持' }]; view.render(result(data));
  assert.equal(find('.composer-common').hidden, true);
  assert.match(find('.composer-feedback').textContent, /时长不支持/);
  assert.match(find('.composer-feedback').textContent, /展开编辑/);
  assert.equal(find('.composer-generate').disabled, true);
});
