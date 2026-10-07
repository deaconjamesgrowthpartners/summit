// Runs migration 007 against a throwaway Postgres, if one is reachable. Set SUMMIT_TEST_PG to libpq
// key=value settings without a dbname (e.g. "host=/tmp/summitpg port=5439 user=postgres") to run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PG = process.env.SUMMIT_TEST_PG;

test('migrations 007 to 016 run twice and every sync and board check passes', { skip: !PG && 'set SUMMIT_TEST_PG to run the SQL checks' }, () => {
  const db = `summit_t${process.pid}`;
  const psql = (args, url = `${PG} dbname=postgres`) => execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  psql(['-c', `create database ${db}`]);
  const target = `${PG} dbname=${db}`;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'summit-'));
    const mig = join(dir, '007.sql');
    writeFileSync(mig, readFileSync('supabase/migrations/007_aspire_sync.sql', 'utf8').replace(/^create extension .*$/gm, ''));
    psql(['-f', 'test/sql/supabase-stub.sql'], target);
    execFileSync('psql', [target, '-q', '-v', 'ON_ERROR_STOP=1', '-v', `mig=${mig}`, '-f', 'test/sql/aspire-sync.test.sql'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // 008 on top: the board's status map
    execFileSync('psql', [target, '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'mig8=supabase/migrations/008_aspire_pipeline_board.sql', '-f', 'test/sql/pipeline-board.test.sql'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // 009 on top: division rules, win rate, test data
    execFileSync('psql', [target, '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'mig9=supabase/migrations/009_aspire_board_rules.sql', '-f', 'test/sql/board-rules.test.sql'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // 010 on top: new maintenance basis and PropertyID
    execFileSync('psql', [target, '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'mig10=supabase/migrations/010_new_maintenance_basis.sql', '-f', 'test/sql/new-maintenance.test.sql'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // 011 on top: dates, targets, status snapshots, the login link
    execFileSync('psql', [target, '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'mig11=supabase/migrations/011_summit_rebuild.sql', '-f', 'test/sql/summit-rebuild.test.sql'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // 012 on top: one deals table for every source, Elevation's numbers unchanged
    execFileSync('psql', [target, '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'mig12=supabase/migrations/012_deal_sources.sql', '-f', 'test/sql/deal-sources.test.sql'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // 013 and 014 on top: CSV upload with a preview, and deals typed in Summit
    execFileSync('psql', [target, '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'mig13=supabase/migrations/013_csv_import.sql', '-v', 'mig14=supabase/migrations/014_native_deals.sql', '-v', 'mig15=supabase/migrations/015_workspaces_29029_deacon_james.sql', '-v', 'mig16=supabase/migrations/016_source_sync_cutover.sql', '-f', 'test/sql/native-csv.test.sql'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    assert.fail(String(e.stderr || e.message));
  } finally {
    psql(['-c', `drop database if exists ${db}`]);
  }
});
