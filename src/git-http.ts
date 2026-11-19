// TEMPORARY STUB — replaced by the git-http builder once git-core lands.
// Returns false for every request so the other surfaces can be tested
// against the sealed suite before smart HTTP exists.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export async function handleGit(_store: Store, _req: IncomingMessage, _res: ServerResponse): Promise<boolean> {
  return false;
}
