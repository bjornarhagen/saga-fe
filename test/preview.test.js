import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function previewFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'saga preview '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const bin = join(root, 'bin');
  const log = join(root, 'docker-calls');
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(resolve('scripts/preview.sh'), join(checkout, 'scripts/preview.sh'));
  writeFileSync(join(checkout, 'compose.preview.yaml'), 'services: {}\n');
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.PREVIEW_TEST_LOG, JSON.stringify({ args, port: process.env.SAGA_FE_PREVIEW_PORT }) + '\\n');
if (args.includes('--help')) console.log(process.env.PREVIEW_TEST_RMI === 'no' ? 'down options' : '--rmi string');
if (args.includes('port')) console.log('127.0.0.1:54321');
`, { mode: 0o755 });
  return {
    checkout,
    run: (args = [], env = {}) => spawnSync('sh', [join(checkout, 'scripts/preview.sh'), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PREVIEW_TEST_LOG: log, SAGA_FE_PREVIEW_PORT: '', ...env },
    }),
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
  };
}

function assertScoped(call, checkout) {
  assert.deepEqual(call.args.slice(0, 6), ['compose', '--project-directory', checkout, '-f', join(checkout, 'compose.preview.yaml'), '-p']);
  assert.match(call.args[6], /^saga-fe-preview-\d+$/);
  assert.notEqual(call.args[6], 'saga-fe');
}

test('preview help and invalid inputs never call Docker or use the main port', t => {
  const preview = previewFixture(t);
  assert.equal(preview.run().status, 0);
  for (const args of [['unknown'], ['up', 'extra'], ['down', '--volumes'], ['status', 'extra'], ['exec']]) {
    assert.equal(preview.run(args).status, 2);
  }
  for (const port of ['5187', '0005187', '0', '000', '-1', '65536', '9999999999999999999999', '5190:4321', '$(touch bad)', ' 5190']) {
    const result = preview.run(['up'], { SAGA_FE_PREVIEW_PORT: port });
    assert.equal(result.status, 2, `Rejected port ${port}: ${result.stderr}`);
  }
  assert.deepEqual(preview.calls(), []);
});

test('preview projects stay separate across checkout paths and stable across commands', t => {
  const first = previewFixture(t);
  const second = previewFixture(t);
  const up = first.run(['up']);
  assert.equal(up.status, 0, up.stderr);
  assert.match(up.stdout, /http:\/\/127\.0\.0\.1:54321/);
  assert.equal(first.run(['status'], { SAGA_FE_PREVIEW_PORT: '5187' }).status, 0);
  assert.equal(second.run(['up'], { SAGA_FE_PREVIEW_PORT: '005190' }).status, 0);
  for (const [preview, port] of [[first, '0'], [second, '5190']]) {
    for (const call of preview.calls()) {
      assertScoped(call, preview.checkout);
      assert.equal(call.port, port);
    }
    assert.deepEqual(preview.calls()[0].args.slice(7), ['up', '-d', '--build', '--wait']);
  }
  assert.equal(first.calls()[0].args[6], first.calls()[2].args[6]);
  assert.notEqual(first.calls()[0].args[6], second.calls()[0].args[6]);
});

test('preview teardown only targets its own project and never removes volumes', t => {
  for (const rmi of ['yes', 'no']) {
    const preview = previewFixture(t);
    const result = preview.run(['down'], { SAGA_FE_PREVIEW_PORT: 'invalid', PREVIEW_TEST_RMI: rmi });
    assert.equal(result.status, 0, result.stderr);
    for (const call of preview.calls()) {
      assertScoped(call, preview.checkout);
      assert.equal(call.port, '0');
      assert.ok(!call.args.includes('--volumes'));
      assert.ok(!call.args.includes('-v'));
    }
    assert.deepEqual(preview.calls().at(-1).args.slice(7), rmi === 'yes' ? ['down', '--remove-orphans', '--rmi', 'local'] : ['down', '--remove-orphans']);
  }
});

test('preview exec preserves command arguments without shell expansion', t => {
  const preview = previewFixture(t);
  const command = ['node', '-e', 'console.log("literal $HOME; $(touch bad)")'];
  const result = preview.run(['exec', ...command]);
  assert.equal(result.status, 0, result.stderr);
  const [call] = preview.calls();
  assertScoped(call, preview.checkout);
  assert.deepEqual(call.args.slice(7), ['exec', '-T', 'app', ...command]);
});
