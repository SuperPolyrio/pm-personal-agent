import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const stateDir = resolve(process.env.PM_STATE_DIR ?? 'var');
export const now = () => new Date().toISOString();
export type RecordKind = 'research' | 'thesis' | 'decision' | 'position';
export type PersonalRecord = { id: string; kind: RecordKind; market_id: number; version: number; data: string; created_at: string };
export type Watch = {
  id: string; schedule_id: string | null; session_id: string; version: number; market_id: number | null;
  goal: string; sources: string; notify_when: string; interval_seconds: number; expires_at: string;
  max_runs: number; max_model_calls: number; max_tool_calls: number; runs: number; status: string;
};

const watchSchema = `(
  id TEXT PRIMARY KEY, schedule_id TEXT, session_id TEXT NOT NULL, version INTEGER NOT NULL,
  market_id INTEGER, goal TEXT NOT NULL, sources TEXT NOT NULL, notify_when TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL CHECK(interval_seconds >= 60), expires_at TEXT NOT NULL,
  max_runs INTEGER NOT NULL CHECK(max_runs > 0), max_model_calls INTEGER NOT NULL CHECK(max_model_calls > 0),
  max_tool_calls INTEGER NOT NULL CHECK(max_tool_calls > 0), runs INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL
)`;

export function openStore(path = resolve(stateDir, 'personal.sqlite')) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS records (
      id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL, market_id INTEGER NOT NULL,
      data TEXT NOT NULL, created_at TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, PRIMARY KEY(id,version)
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, retrieved_at TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watches ${watchSchema};
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, watch_id TEXT, watch_version INTEGER,
      started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, model_calls INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS watch_versions (
      watch_id TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(watch_id,version)
    );
    CREATE TABLE IF NOT EXISTS coverage (
      run_id TEXT NOT NULL, path TEXT NOT NULL, evidence_id TEXT, status TEXT NOT NULL, detail TEXT NOT NULL,
      PRIMARY KEY(run_id,path)
    );
    CREATE TABLE IF NOT EXISTS notices (
      id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, run_id TEXT NOT NULL, event_key TEXT NOT NULL,
      body TEXT NOT NULL, created_at TEXT NOT NULL, delivery_status TEXT NOT NULL DEFAULT 'pending',
      UNIQUE(watch_id,event_key)
    );`);
  const marketRequired = () => db.prepare("SELECT \"notnull\" FROM pragma_table_info('watches') WHERE name='market_id'").get()?.notnull === 1;
  if (marketRequired()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (marketRequired()) db.exec(`
        CREATE TABLE watches_migrating ${watchSchema};
        INSERT INTO watches_migrating SELECT id,schedule_id,session_id,version,market_id,goal,sources,notify_when,
          interval_seconds,expires_at,max_runs,max_model_calls,max_tool_calls,runs,status FROM watches;
        DROP TABLE watches;
        ALTER TABLE watches_migrating RENAME TO watches;`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  return db;
}

export function saveRecord(db: DatabaseSync, input: {
  id?: string; expectedVersion?: number; kind: RecordKind; marketId: number; data: unknown; operationId: string;
}) {
  const previousOperation = db.prepare('SELECT * FROM records WHERE operation_id=?').get(input.operationId);
  if (previousOperation) return previousOperation;
  const id = input.id ?? randomUUID();
  const latest = db.prepare('SELECT version,kind,market_id FROM records WHERE id=? ORDER BY version DESC LIMIT 1').get(id);
  if (input.id && (!latest || latest.version !== input.expectedVersion)) throw new Error('记录版本已变化或记录不存在；先读取当前版本。');
  if (latest && (latest.kind !== input.kind || latest.market_id !== input.marketId)) throw new Error('不能修改记录的类型或所属市场。');
  const version = Number(latest?.version ?? 0) + 1;
  db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').run(id, version, input.kind, input.marketId, JSON.stringify(input.data), now(), input.operationId);
  return db.prepare('SELECT * FROM records WHERE id=? AND version=?').get(id, version)!;
}

export function listRecords(db: DatabaseSync, marketId?: number) {
  return db.prepare(`SELECT r.* FROM records r WHERE version=(SELECT MAX(version) FROM records WHERE id=r.id)
    AND (? IS NULL OR market_id=?) ORDER BY created_at DESC LIMIT 100`).all(marketId ?? null, marketId ?? null);
}

export function saveEvidence(db: DatabaseSync, source: string, data: unknown, retrievedAt = now(), id: string = randomUUID()) {
  db.prepare('INSERT INTO evidence VALUES (?,?,?,?)').run(id, source, retrievedAt, JSON.stringify(data));
  return { evidenceId: id, source, retrievedAt, data };
}

export function getWatch(db: DatabaseSync, id: string) {
  const watch = db.prepare('SELECT * FROM watches WHERE id=?').get(id) as Watch | undefined;
  if (!watch) throw new Error('持续任务不存在。');
  return watch;
}

export function saveWatchVersion(db: DatabaseSync, id: string) {
  const watch = getWatch(db, id);
  db.prepare('INSERT INTO watch_versions VALUES (?,?,?,?)').run(id, watch.version, now(), JSON.stringify(watch));
  return watch;
}
