// tenant-client-read-retry.test.ts — ADV-24. Opt-in wait-and-retry for GET reads that answer 429 or
// 503, and an HTTP-date `Retry-After` read as seconds. One test per ticket scenario. `sleep` is
// injected, so no test waits for real: it records each wait in ms and returns at once.

import { describe, expect, it } from "vitest";
import { json, scriptedFetch, type Scripted } from "./helpers/scripted-fetch";
import { createTenantClient, type ReadRetryOptions } from "../src/index";

const BASE = "https://cloud.example";
const KEY = "ctc_user_reader";
/** Deliberately off a whole second: an HTTP date 3 s ahead is then 2.5 s away and must read 3. */
const NOW_MS = 1_700_000_000_500;

function setup(script: Scripted[], readRetry?: Omit<ReadRetryOptions, "sleep">) {
  const net = scriptedFetch(script);
  const waits: number[] = [];
  const client = createTenantClient({
    key: KEY,
    baseUrl: BASE,
    fetch: net.fetch,
    now: () => NOW_MS,
    ...(readRetry === undefined
      ? {}
      : {
          readRetry: {
            ...readRetry,
            sleep: async (ms: number) => {
              waits.push(ms);
            },
          },
        }),
  });
  return { client, calls: net.calls, waits };
}

describe("tenant client read retry (ADV-24)", () => {
  it("a read waits out a 429 and retries when retry is turned on", async () => {
    const { client, calls, waits } = setup(
      [() => json(429, { reason: "linear read floor reached" }, { "retry-after": "2" }), () => json(200, { id: "me" })],
      { maxWaitSeconds: 10 },
    );
    const r = await client.request({ path: "/api/v1/me" });
    expect(waits).toEqual([2000]);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(r).toMatchObject({ outcome: "ok", status: 200, json: { id: "me" } });
  });

  it("a Retry-After given as an HTTP date is honoured", async () => {
    const { client, calls } = setup([
      () => json(429, { reason: "linear read floor reached" }, { "retry-after": new Date(NOW_MS + 3000).toUTCString() }),
    ]);
    const r = await client.request({ path: "/api/v1/me" });
    expect(r).toMatchObject({ outcome: "rate-limited", status: 429, retryAfterSeconds: 3 });
    expect(calls).toHaveLength(1);
  });

  it("a write is never retried", async () => {
    const { client, calls, waits } = setup(
      [() => json(503, { error: "service unavailable" }), () => json(200, { outcome: "succeeded" })],
      { maxWaitSeconds: 10 },
    );
    const r = await client.request({ method: "POST", path: "/api/v1/agent/x/issue-comment", body: { issueId: "i1" } });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(r).toMatchObject({ outcome: "http", status: 503 });
  });

  it("a wait longer than the limit is returned, not slept", async () => {
    const { client, calls, waits } = setup(
      [() => json(429, { reason: "linear read floor reached" }, { "retry-after": "60" }), () => json(200, { id: "me" })],
      { maxWaitSeconds: 10 },
    );
    const r = await client.request({ path: "/api/v1/me" });
    expect(r).toMatchObject({ outcome: "rate-limited", status: 429, retryAfterSeconds: 60 });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("retry stays off unless asked for", async () => {
    const { client, calls, waits } = setup([() => json(503, { error: "service unavailable" }), () => json(200, { id: "me" })]);
    const r = await client.request({ path: "/api/v1/me" });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(r).toMatchObject({ outcome: "http", status: 503 });
  });
});
