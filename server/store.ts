import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createStoreFromDatabase } from './store-core.ts';

export function createStore(filename: string, demo: boolean) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  return createStoreFromDatabase(new DatabaseSync(filename), demo);
}
export type { Store } from './store-core.ts';
