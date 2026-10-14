import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('publication guard rejects private imports, generated output and credential contents without printing values', () => {
  const root = mkdtempSync(join(tmpdir(), 'saga-fe-privacy-'));
  const audit = () => spawnSync(process.execPath, ['scripts/privacy-check.mjs', `--root=${root}`], { encoding: 'utf8' });
  try {
    writeFileSync(join(root, 'package.json'), '{}');
    assert.equal(audit().status, 0);
    for (const name of ['bank.csv', 'accounts.json', 'ACCOUNTS.JSON', 'auth.json']) {
      writeFileSync(join(root, name), 'synthetic-private-value');
      const result = audit();
      assert.equal(result.status, 1);
      assert.ok(!result.stderr.includes('synthetic-private-value'));
      rmSync(join(root, name));
    }
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'embedded.js'), 'example');
    assert.equal(audit().status, 1);
    rmSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'configuration.txt'), JSON.stringify({ sessionKey: 'synthetic-session-key-that-is-long-enough-for-detection' }));
    const result = audit();
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes('synthetic-session-key'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
