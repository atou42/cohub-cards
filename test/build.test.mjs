import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';

test('bundled SDK is inserted literally and leaves no card placeholders',async()=>{
  await promisify(execFile)(process.execPath,['scripts/build.mjs'],{cwd:new URL('../',import.meta.url)});
  const html=await readFile(new URL('../dist/card.html',import.meta.url),'utf8');
  assert.ok(html.includes('<script type="module">'));
  assert.ok(html.includes('<style>'));
  assert.ok(!html.includes('<!--CARD_'));
  assert.equal((html.match(/<html /g)||[]).length,1);
});
