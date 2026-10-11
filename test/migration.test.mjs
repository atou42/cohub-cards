import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'cohub-migration-'));
  const upstream = path.join(root, 'upstream');
  const bridge = path.join(root, 'bridge');
  const bin = path.join(root, 'bin');
  const receipt = path.join(root, 'receipt.json');
  const log = path.join(root, 'git.log');
  for (const dir of [upstream, bridge, bin]) mkdirSync(dir);
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', RECEIPT: receipt, GIT_LOG: log, REAL_GIT: realGit, UPSTREAM: upstream };
  const git = (...args) => {
    const result = spawnSync(realGit, args, { cwd: upstream, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  mkdirSync(path.join(upstream, 'scripts'));
  writeFileSync(path.join(upstream, 'scripts', 'install.sh'), '#!/usr/bin/env bash\nnode -e \'require("node:fs").writeFileSync(process.env.RECEIPT, JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}))\' -- "$@"\nexit "${INSTALL_STATUS:-0}"\n');
  git('add', '.');
  git('-c', 'user.name=Migration Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture installer');
  const commit = git('rev-parse', 'HEAD');
  git('-c', 'user.name=Migration Test', '-c', 'user.email=test@example.invalid', 'tag', '-a', 'cohub-v2.3.0', '-m', 'Release');
  return finishFixture();

  function finishFixture() {
    cpSync(path.join(source, 'scripts'), path.join(bridge, 'scripts'), { recursive: true });
    const manifest = { repository: 'https://github.com/atou42/cohub-skill.git', tag: 'cohub-v2.3.0', commit };
    writeFileSync(path.join(bridge, 'migration.json'), JSON.stringify(manifest));
    writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env node\nimport("node:fs").then(async fs=>{ const cp=await import("node:child_process"); let args=process.argv.slice(2); fs.appendFileSync(process.env.GIT_LOG,JSON.stringify(args)+"\\n"); if(args[0]==="clone"){if(process.env.NETWORK_FAILURE==="1")process.exit(73);args=args.map(a=>a==="https://github.com/atou42/cohub-skill.git"?process.env.UPSTREAM:a);}const r=cp.spawnSync(process.env.REAL_GIT,args,{stdio:"inherit"});process.exit(r.status??99);});\n');
    chmodSync(path.join(bin, 'git'), 0o755);
    env.PATH = `${bin}:${process.env.PATH}`;
    const run = (args = [], extra = {}) => spawnSync('bash', [path.join(bridge, 'scripts/install.sh'), ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });
    const cache = path.join(bridge, '.cohub-source', commit);
    return { root, bridge, upstream, commit, manifest, receipt, log, cache, run, git };
  }
}

test('forwards exact arguments, runs the pinned release, and reuses verified cache offline', () => {
  const f = fixture();
  const args = ['--language', 'zh-CN', '--skill-mode', 'external', '--skill-path', '/a path/技能 $(false)'];
  const first = f.run(args);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.receipt)), { args, cwd: realpathSync(f.cache) });
  const second = f.run(args, { NETWORK_FAILURE: '1' });
  assert.equal(second.status, 0, second.stderr);
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(a => a[0] === 'clone').length, 1);
  assert.ok(!calls.some(a => a.includes('main') || a.includes('remote')));
});

test('propagates the target installer exit status without retry', () => {
  const f = fixture();
  assert.equal(f.run([], { INSTALL_STATUS: '42' }).status, 42);
  assert.ok(existsSync(f.receipt));
});

test('accepts an independent plugin release tag while still enforcing its pinned commit', () => {
  const f = fixture();
  const tag = 'cohub-plugin-v0.7.0';
  f.git('tag', tag);
  writeFileSync(path.join(f.bridge, 'migration.json'), JSON.stringify({ ...f.manifest, tag }));
  const result = f.run(['--language', 'en']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.receipt)).args, ['--language', 'en']);
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(args => args[0] === 'clone' && args.includes(tag)));
  const commitResult = spawnSync(realGit, ['-C', f.cache, '-c', 'user.name=Migration Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Different commit'], { encoding: 'utf8' });
  assert.equal(commitResult.status, 0, commitResult.stderr);
  writeFileSync(f.receipt, 'do not replace');
  const rejected = f.run();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Release commit mismatch/);
  assert.equal(readFileSync(f.receipt, 'utf8'), 'do not replace');
});

test('rejects a release tag pointing to a different commit before installation', () => {
  const f = fixture();
  writeFileSync(path.join(f.upstream, 'new'), 'new release');
  f.git('add', '.');
  f.git('-c', 'user.name=Migration Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Moved tag');
  f.git('tag', '-f', 'cohub-v2.3.0');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release commit mismatch/);
  assert.equal(existsSync(f.receipt), false);
  assert.equal(existsSync(f.cache), false);
});

test('network failure is exposed and never runs the old installer', () => {
  const f = fixture();
  const result = f.run([], { NETWORK_FAILURE: '1' });
  assert.equal(result.status, 73);
  assert.match(result.stderr, /git|clone|fetch/i);
  assert.equal(existsSync(f.receipt), false);
});

test('dirty cache is preserved byte for byte and installation stops', () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const installer = path.join(f.cache, 'scripts/install.sh');
  writeFileSync(installer, 'user edits\n');
  writeFileSync(path.join(f.cache, 'notes'), 'keep these notes');
  writeFileSync(f.receipt, 'do not replace');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dirty|changes|clean/i);
  assert.equal(readFileSync(installer, 'utf8'), 'user edits\n');
  assert.equal(readFileSync(path.join(f.cache, 'notes'), 'utf8'), 'keep these notes');
  assert.equal(readFileSync(f.receipt, 'utf8'), 'do not replace');
});

test('corrupt cache is preserved and never replaced or used', () => {
  const f = fixture();
  mkdirSync(f.cache, { recursive: true });
  writeFileSync(path.join(f.cache, 'evidence'), 'keep this');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(path.join(f.cache, 'evidence'), 'utf8'), 'keep this');
  assert.equal(existsSync(f.receipt), false);
});

test('a clean cache on the wrong commit is rejected without resetting it', () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const result = spawnSync(realGit, ['-C', f.cache, '-c', 'user.name=Migration Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Local commit'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const readHead = () => spawnSync(realGit, ['-C', f.cache, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const changedHead = readHead();
  assert.notEqual(changedHead, f.commit);
  writeFileSync(f.receipt, 'do not replace');
  const rejected = f.run();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Release commit mismatch/);
  assert.equal(readHead(), changedHead);
  assert.equal(readFileSync(f.receipt, 'utf8'), 'do not replace');
});

test('unpublished placeholder fails before any network or install attempt', () => {
  const f = fixture();
  writeFileSync(path.join(f.bridge, 'migration.json'), JSON.stringify({ ...f.manifest, commit: '0'.repeat(40) }));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /placeholder|unpublished|release/i);
  assert.equal(existsSync(f.log), false);
  assert.equal(existsSync(f.receipt), false);
});
