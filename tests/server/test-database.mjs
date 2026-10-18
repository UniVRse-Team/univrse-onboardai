// In-process PostgreSQL for account tests: pg-mem running the real migration
// files through the real migration runner. No Docker, no network.
//
// pg-mem lacks a few PostgreSQL built-ins, added here: gen_random_uuid(), the
// `~` regular-expression operator used by CHECK constraints, and
// pg_advisory_xact_lock(). Its pg adapter also commits every query on its own,
// so this pool provides transactions: BEGIN takes a snapshot, ROLLBACK
// restores it, COMMIT keeps the changes; SAVEPOINT and ROLLBACK TO SAVEPOINT
// do the same within one. Transactions run one at a time. The
// live run against the Docker PostgreSQL proves the same SQL on the real engine.
import { randomUUID } from 'node:crypto';
import { newDb, DataType } from 'pg-mem';
import { migrate } from '../../server/database-migrations.mjs';

export async function createTestDatabase() {
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: randomUUID,
    impure: true,
  });
  db.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer],
    returns: DataType.integer,
    implementation: () => 0,
    impure: true,
  });
  db.public.registerOperator({
    operator: '~',
    left: DataType.text,
    right: DataType.text,
    returns: DataType.bool,
    implementation: (value, pattern) => new RegExp(pattern).test(value),
  });
  const { Pool } = db.adapters.createPg();
  const inner = new Pool();
  const faults = [];
  let queue = Promise.resolve();
  const statements = [];

  // pg-mem names an inline CHECK <table>_constraint_<n> where PostgreSQL names
  // it <table>_<column>_check, so migration 004's DROP CONSTRAINT of the 2-letter
  // prefix rule would find nothing. The live run covers the real name.
  // Migration 005 drops the inline role rule (accounts_role_check in
  // PostgreSQL, the third inline CHECK of 001 in pg-mem) the same way.
  const pgMemNames = (text) =>
    typeof text === 'string'
      ? text
          .replace(
            'DROP CONSTRAINT IF EXISTS employee_id_counters_prefix_check',
            'DROP CONSTRAINT IF EXISTS employee_id_counters_constraint_1',
          )
          .replace(
            'DROP CONSTRAINT IF EXISTS accounts_role_check;',
            'DROP CONSTRAINT IF EXISTS accounts_constraint_3;',
          )
      : text;

  async function query(rawText, values) {
    const text = pgMemNames(rawText);
    statements.push(typeof text === 'string' ? text : text.text);
    const fault = faults.find((f) => f.times > 0 && (!f.match || f.match.test(text)));
    if (fault) {
      fault.times--;
      throw Object.assign(new Error('Injected database failure with a private value'), {
        code: fault.code,
      });
    }
    return inner.query(text, values);
  }

  const pool = {
    query,
    async connect() {
      let snapshot = null,
        finish = null;
      const savepoints = new Map();
      return {
        async query(text, values) {
          const command = typeof text === 'string' ? text.trim().toUpperCase() : '';
          if (command === 'BEGIN') {
            const previous = queue;
            queue = new Promise((resolve) => (finish = resolve));
            await previous;
            snapshot = db.backup();
            return { rows: [], rowCount: 0 };
          }
          const savepoint = /^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT) (\w+)$/.exec(
            command,
          );
          if (savepoint) {
            const [, action, name] = savepoint;
            if (action === 'SAVEPOINT') savepoints.set(name, db.backup());
            else if (!savepoints.has(name)) throw new Error(`No savepoint ${name}`);
            else if (action === 'ROLLBACK TO SAVEPOINT') savepoints.get(name).restore();
            else savepoints.delete(name);
            return { rows: [], rowCount: 0 };
          }
          if (command === 'COMMIT' || command === 'ROLLBACK') {
            if (command === 'ROLLBACK') snapshot?.restore();
            snapshot = null;
            savepoints.clear();
            finish?.();
            finish = null;
            return { rows: [], rowCount: 0 };
          }
          return query(text, values);
        },
        release() {
          finish?.();
        },
      };
    },
    end: async () => {},
  };
  const migrated = await migrate(pool);
  return {
    db,
    pool,
    migrated,
    statements,
    // The next `times` queries (optionally only those matching `match`) fail
    // with this SQLSTATE, like a lost database connection.
    fail(code = '57P01', { times = 1, match = null } = {}) {
      faults.push({ code, times, match });
    },
    rows: (sql, values) => inner.query(sql, values).then((result) => result.rows),
  };
}
