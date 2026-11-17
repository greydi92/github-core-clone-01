// Entrypoint for the Fleet Parallax forge.
//
// Boot sequence, per the competition wire spec:
//   1. Read the suite's base URL from MAKEFUN_ENV_URL (fatal if absent).
//   2. Build the forge HTTP server with createApp() and bind an ephemeral
//      port chosen by the kernel (port 0). Port 8080 belongs to the suite
//      and must never be bound here.
//   3. Tell the suite where we are listening by POSTing {"port": N} to
//      <env>/register. HTTP 200 and 409 both count as registered.
//   4. Keep polling GET <env>/done until the suite answers {"done": true}.
//      We never exit early: the suite needs the forge alive for the whole
//      trial, and only its "done" answer ends the run.
//   5. Shut the server down cleanly and exit 0.
//
// Any unrecoverable failure (no env URL, bind failure, registration that
// never succeeds) exits 1 so the harness can tell a broken boot apart
// from a finished trial.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

// Pause helper: resolves after the given number of milliseconds.
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Backoff for a retry loop: starts short, grows, and caps out so a
// transient suite hiccup does not turn into a hot spin.
function backoffMs(attempt: number): number {
  const step = 500 * 2 ** attempt;
  return Math.min(step, 10_000);
}

// Read the suite origin once, stripping a trailing slash so the two
// endpoint paths below join cleanly. Exits the process when unset.
function suiteOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') {
    console.error('main: MAKEFUN_ENV_URL is not set; cannot register with the suite');
    process.exit(1);
  }
  return raw.replace(/\/+$/, '');
}

// POST {"port": port} to <origin>/register until the suite accepts it.
// 200 (registered) and 409 (already registered) are both success; any
// other status or a network error waits out a backoff and tries again.
async function announcePort(origin: string, port: number): Promise<void> {
  const target = `${origin}/register`;
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch (err) {
      console.error(`main: register attempt ${attempt + 1} failed to reach ${target}:`, err);
      await pause(backoffMs(attempt));
      attempt += 1;
      continue;
    }
    if (response.status === 200 || response.status === 409) {
      console.log(`main: registered on port ${port} (suite answered ${response.status})`);
      return;
    }
    console.error(`main: register attempt ${attempt + 1} answered HTTP ${response.status}; retrying`);
    await pause(backoffMs(attempt));
    attempt += 1;
  }
}

// GET <origin>/done in a loop until the suite answers {"done": true}.
// A failed fetch or a non-JSON body is treated as "not done yet": we
// wait and ask again rather than giving up on the trial.
async function waitForSuiteDone(origin: string): Promise<void> {
  const target = `${origin}/done`;
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(target);
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) {
          console.log('main: suite reports done; shutting down');
          return;
        }
      } else {
        console.error(`main: /done answered HTTP ${response.status}; still waiting`);
      }
    } catch (err) {
      console.error(`main: /done poll ${attempt + 1} failed:`, err);
    }
    attempt += 1;
    await pause(1000);
  }
}

// Bind the forge, register it, wait for the suite, then stop it.
async function boot(): Promise<void> {
  const origin = suiteOrigin();
  const forge = createApp();

  // A server error after boot (e.g. a client dropping mid-request) must
  // never take the forge down uncaught mid-trial: log it and keep serving.
  forge.on('error', (err: Error) => {
    console.error('main: forge server error (continuing):', err);
  });

  // Bind port 0 on all interfaces and wait until the kernel hands us a
  // real port number. A bind error here is fatal: without a listening
  // socket there is no forge for the suite to drive.
  const listeningPort: number = await new Promise((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, '0.0.0.0', () => {
      const info = forge.address() as AddressInfo | string | null;
      if (info === null || typeof info === 'string') {
        reject(new Error('main: server address is not available after listen'));
        return;
      }
      resolve(info.port);
    });
  });
  console.log(`main: forge listening on port ${listeningPort}`);

  try {
    await announcePort(origin, listeningPort);
    await waitForSuiteDone(origin);
  } finally {
    // Close even if the wait above threw: a lingering process would
    // hold the trial's wall budget open.
    await new Promise<void>((resolve) => {
      forge.close(() => resolve());
    });
  }
}

boot().catch((err: unknown) => {
  console.error('main: fatal boot error:', err);
  process.exit(1);
});
