import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTwitchOAuthWithDatabase, type OAuthOptions } from './oauth-core.ts';

export function createTwitchOAuth(options: OAuthOptions) {
  if (options.databasePath !== ':memory:') mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
  return createTwitchOAuthWithDatabase(options, new DatabaseSync(options.databasePath));
}
export type { TwitchAccount, TwitchUserProfile } from './oauth-core.ts';
