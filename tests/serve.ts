// Local dev runner for the fast test loop. NOT used in trials (main.ts is
// the entrypoint there). Starts the forge on an ephemeral port and prints
// its URL, then serves until killed.
//
//   MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types tests/serve.ts

import { createApp } from '../app.ts';

const server = createApp();
server.listen(0, () => {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('did not bind a port');
  process.stdout.write(`listening on http://127.0.0.1:${address.port}\n`);
});
