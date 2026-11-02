import type { SqlDatabase } from '../server/sql-database.ts';
import type { DurableObjectStorage } from '@cloudflare/workers-types';

export function durableDatabase(storage: DurableObjectStorage): SqlDatabase {
  const binding = (value: any) => ArrayBuffer.isView(value) ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value;
  return {
    exec(sql) { return storage.sql.exec(sql.replace(/PRAGMA[^;]*;/gi, '')); },
    prepare(sql) {
      const query = (values: any[]) => storage.sql.exec(sql, ...values.map(binding));
      return {
        get: (...values) => query(values).toArray()[0],
        all: (...values) => query(values).toArray(),
        run: (...values) => { query(values); return { changes: Number(storage.sql.exec('SELECT changes() AS changes').one().changes) }; },
      };
    },
    transaction: work => storage.transactionSync(work),
    close() {},
  };
}

export function persistentMap<T>(storage: DurableObjectStorage, name: string): Map<string, T> {
  const map = new Map<string, T>(storage.kv.get<[string, T][]>(name) || []);
  const save = () => storage.kv.put(name, [...map]);
  map.set = (key, value) => { Map.prototype.set.call(map, key, value); save(); return map; };
  map.delete = key => { const deleted = Map.prototype.delete.call(map, key); save(); return deleted; };
  map.clear = () => { Map.prototype.clear.call(map); storage.kv.delete(name); };
  return map;
}
