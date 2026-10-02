/** `Store` over bun:sqlite, the same statements the worker runs on sqlite-wasm. */
import { Database } from "bun:sqlite";

import { Store, type SqlDb, type SqlValue } from "client/threads/db/store";

export function bunSqlDb(): SqlDb & { database: Database } {
  const database = new Database(":memory:");
  return {
    database,
    run(sql, params = []) {
      database.query(sql).run(...(params as never[]));
    },
    all<T>(sql: string, params: SqlValue[] = []): T[] {
      return database.query(sql).all(...(params as never[])) as T[];
    },
    transaction<T>(fn: () => T): T {
      return database.transaction(fn)();
    },
  };
}

export function openTestStore(): Store {
  const store = new Store(bunSqlDb());
  store.migrate();
  return store;
}
