// gitforge entrypoint: the trial lifecycle. It binds the forge on an ephemeral
// port, tells the trial environment which port it picked, then polls until the
// environment says the suite is done and exits 0. The forge itself lives in
// app.ts; this file only owns the bind -> register -> wait -> exit dance.
//
// Protocol (see the kit's env/src/wire.ts):
//   1. MAKEFUN_ENV_URL names the env origin. Without it there is nothing to
//      talk to, so exit 1 at once.
//   2. Listen on port 0: the kernel picks a free port. Never bind 8080, the
//      env's own port.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The first register wins; a
//      409 means another entry already registered and is not fatal.
//   4. GET $MAKEFUN_ENV_URL/done until it answers {"done": true}, polling
//      with a short exponential backoff. Never exit before that.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (ENV_URL === '') {
  process.stderr.write('[gitforge] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Env not answering yet: keep polling.
    }
    await sleep(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[gitforge] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[gitforge] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[gitforge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[gitforge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
