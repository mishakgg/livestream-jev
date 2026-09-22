import { describe, expect, it, vi } from "vitest";
import { startWithRetry } from "./startup.js";

describe("startWithRetry", () => {
  it("returns the first success without sleeping", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const start = vi.fn(async () => "ok");
    await expect(startWithRetry({ attempts: 3, delayMs: 1000, sleep }, start)).resolves.toBe("ok");
    expect(start).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries failures with the injected delay, then returns success", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const seen: unknown[] = [];
    let calls = 0;
    const out = await startWithRetry(
      {
        attempts: 5,
        delayMs: 250,
        sleep,
        onAttemptFailed: (_attempt, err) => void seen.push(err),
      },
      async () => {
        calls += 1;
        if (calls < 3) throw new Error(`boom-${calls}`);
        return "ready";
      }
    );
    expect(out).toBe("ready");
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(seen).toHaveLength(2);
  });

  it("throws the last error after exhausting attempts", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const start = vi.fn(async (): Promise<string> => {
      throw new Error("down");
    });
    await expect(startWithRetry({ attempts: 3, delayMs: 10, sleep }, start)).rejects.toThrow("down");
    expect(start).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
