export interface StartupRetryOptions {
  attempts: number;
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
  onAttemptFailed?: (attempt: number, err: unknown) => void;
}

/**
 * Run an async start function with bounded retries. The worker boots
 * concurrently with database provisioning (Playwright starts webServers
 * while e2e global setup is still creating the database; `docker compose
 * up` has the same ordering), so a single start attempt can fail with
 * "database does not exist" and must not be fatal. Timing is injected so
 * tests stay deterministic: production passes real attempts/delay, tests
 * pass fakes and assert exact call counts.
 */
export async function startWithRetry<T>(
  opts: StartupRetryOptions,
  start: () => Promise<T>
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      return await start();
    } catch (err) {
      lastErr = err;
      opts.onAttemptFailed?.(attempt, err);
      if (attempt < opts.attempts) await sleep(opts.delayMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("start failed after retries");
}
