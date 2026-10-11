import { readFileSync, existsSync, mkdirSync, lstatSync, realpathSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${command} ${args[0]} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}. Existing files have been preserved.`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return capture ? result.stdout.trim() : '';
}

function requireDirectory(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected an ordinary directory: ${directory}. Existing files have been preserved.`);
}

function verify(checkout, manifest) {
  requireDirectory(checkout);
  const top = run('git', ['rev-parse', '--show-toplevel'], checkout, true);
  if (realpathSync(top) !== realpathSync(checkout)) throw new Error(`Invalid release cache: ${checkout}. Existing files have been preserved.`);
  const head = run('git', ['rev-parse', 'HEAD'], checkout, true);
  const tag = run('git', ['rev-parse', `refs/tags/${manifest.tag}^{commit}`], checkout, true);
  if (head !== manifest.commit || tag !== manifest.commit) throw new Error(`Release commit mismatch in ${checkout}. Expected ${manifest.commit}; HEAD=${head}, tag=${tag}. Existing files have been preserved.`);
  const changes = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], checkout, true);
  if (changes) throw new Error(`Release cache has local changes: ${checkout}. Restore a clean checkout manually; existing files have been preserved.`);
  const installer = path.join(checkout, 'scripts/install.sh');
  const stat = lstatSync(installer);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release installer is missing or invalid: ${installer}`);
}

function main() {
  const manifest = JSON.parse(readFileSync(path.join(root, 'migration.json'), 'utf8'));
  if (manifest.repository !== 'https://github.com/atou42/cohub-skill.git' || !/^cohub(?:-plugin)?-v\d+\.\d+\.\d+$/.test(manifest.tag ?? '') || !/^[a-f0-9]{40}$/.test(manifest.commit ?? '')) {
    throw new Error('Invalid migration release manifest. No installation was attempted.');
  }
  if (manifest.commit === '0'.repeat(40)) throw new Error('Migration release is unpublished (placeholder commit). No installation was attempted.');
  const cacheRoot = path.join(root, '.cohub-source');
  if (!existsSync(cacheRoot)) mkdirSync(cacheRoot);
  requireDirectory(cacheRoot);
  const cache = path.join(cacheRoot, manifest.commit);
  if (!existsSync(cache)) {
    const pending = path.join(cacheRoot, `.fetch-${manifest.commit}-${randomUUID()}`);
    console.log(`Cohub has moved to ${manifest.repository}. Fetching pinned release ${manifest.tag}.`);
    run('git', ['clone', '--depth', '1', '--single-branch', '--branch', manifest.tag, '--', manifest.repository, pending], root);
    verify(pending, manifest);
    renameSync(pending, cache);
  }
  verify(cache, manifest);
  run('bash', ['scripts/install.sh', ...process.argv.slice(2)], cache);
}

try {
  main();
} catch (error) {
  console.error(`Cohub upgrade stopped: ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
}
