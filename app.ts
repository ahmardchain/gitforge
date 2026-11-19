// gitforge server: one Store, four surfaces. Routing order matters only in
// that each handler claims exactly its own paths and returns false for
// everything else; anything unclaimed is a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { pathOf, sendError, sendJson } from './src/http-util.ts';
import { handleGit } from './src/git-http.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

/** Build the server. It binds nothing until the caller listens; the entry
 * listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (await handleGit(store, req, res)) return;
        if (await handleRest(store, req, res)) return;
        if (await handleGraphql(store, req, res)) return;
        if (await handleMcp(store, req, res)) return;

        sendError(res, 404, 'Not Found');
      } catch {
        // Never answer HTML and never leak a stack: a plain JSON 500.
        try {
          if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
          else res.destroy();
        } catch {
          // The socket is already gone; nothing left to do.
        }
      }
    })();
  });
}
