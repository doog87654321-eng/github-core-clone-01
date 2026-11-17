// main.ts — the trial lifecycle: bind an ephemeral port, register it with the
// env, then poll the env until it says the trial is done and exit 0. Without
// MAKEFUN_ENV_URL the server runs standalone, which is how local verification
// drives it.

import { Store } from './store.ts';
import { createServer } from './server.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function postJson(url: string, value: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  return { status: response.status, text: await response.text() };
}

async function getJson(url: string): Promise<{ status: number; value: unknown }> {
  const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
  let value: unknown = null;
  try {
    value = JSON.parse(await response.text());
  } catch {
    value = null;
  }
  return { status: response.status, value };
}

async function main(): Promise<number> {
  const store = new Store();
  const server = createServer(store);
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    console.error('forge: could not bind a port');
    return 1;
  }
  const port = address.port;
  console.log(`forge: listening on http://127.0.0.1:${port}`);

  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') {
    console.log('forge: MAKEFUN_ENV_URL is not set; running standalone');
    // Serve forever; the process stays alive on the listening socket.
    await new Promise<void>(() => {});
    return 0;
  }

  // Register: 200 or 409 wins; anything else is retried with backoff for 30 s.
  const registerUrl = `${envUrl}/register`;
  const started = Date.now();
  let delay = 250;
  for (;;) {
    try {
      const { status } = await postJson(registerUrl, { port });
      if (status === 200 || status === 409) break;
      if (status === 400 || status === 405) {
        console.error(`forge: register refused with HTTP ${status}`);
        return 1;
      }
      console.error(`forge: register answered HTTP ${status}; retrying`);
    } catch (err) {
      console.error(`forge: register failed: ${err instanceof Error ? err.message : String(err)}; retrying`);
    }
    if (Date.now() - started > 30_000) {
      console.error('forge: register did not succeed within 30 s');
      return 1;
    }
    await sleep(delay);
    delay = Math.min(2000, delay * 2);
  }
  console.log('forge: registered with the env');

  // Poll done until the suite finishes, then exit 0.
  const doneUrl = `${envUrl}/done`;
  for (;;) {
    try {
      const { value } = await getJson(doneUrl);
      if (value !== null && typeof value === 'object' && (value as Record<string, unknown>).done === true) {
        console.log('forge: trial done; exiting');
        server.close();
        return 0;
      }
    } catch {
      // A failed poll is transient; the next one follows.
    }
    await sleep(500);
  }
}

const code = await main();
process.exit(code);
