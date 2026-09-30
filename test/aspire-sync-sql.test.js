// Runs migration 007 against a throwaway Postgres, if one is reachable. Set SUMMIT_TEST_PG to libpq
// key=value settings without a dbname (e.g. "host=/tmp/summitpg port=5439 user=postgres") to run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PG = process.env.SUMMIT_TEST_PG;

test('migration 007 runs twice and every sync check passes', { skip: !PG && 'set SUMMIT_TEST_PG to run the SQL checks' }, () => {
  const db = `summit_t${process.pid}`;
  const psql = (args, url = `${PG} dbname=postgres`) => execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  psql(['-c', `create database ${db}`]);
  const target = `${PG} dbname=${db}`;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'summit-'));
    const mig = join(dir, '007.sql');
    writeFileSync(mig, readFileSync('supabase/migrations/007_aspire_sync.sql', 'utf8').replace(/^create extension .*$/gm, ''));
    psql(['-f', 'test/sql/supabase-stub.sql'], target);
    const out = execFileSync('psql', [target, '-q', '-v', 'ON_ERROR_STOP=1', '-v', `mig=${mig}`, '-f', 'test/sql/aspire-sync.test.sql'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(out !== undefined);
  } catch (e) {
    assert.fail(String(e.stderr || e.message));
  } finally {
    psql(['-c', `drop database if exists ${db}`]);
  }
});
