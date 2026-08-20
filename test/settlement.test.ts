import test from "node:test";
import assert from "node:assert/strict";
import { resolveSettlement, paymentsInBatch, type TransferRecord } from "../src/settlement.js";

const BATCH = "0xc0ba816a46d8aad425bbd8b7fdcd3e197b53da96989c4feb8695ef9a43dad294";

/** Shape recorded from a real Circle x402 response. Note `txHash`, which the SDK does not type. */
function transfer(over: Partial<TransferRecord> = {}): TransferRecord {
  return {
    id: "05c7355d-f80d-4c1d-b79f-0ff7986cb57f",
    status: "completed",
    token: "USDC",
    sendingNetwork: "eip155:5042002",
    recipientNetwork: "eip155:5042002",
    fromAddress: "0x1111111111111111111111111111111111111111",
    toAddress: "0x2222222222222222222222222222222222222222",
    amount: "5006",
    txHash: BATCH,
    createdAt: "2026-07-07T00:52:55.088Z",
    updatedAt: "2026-07-07T00:56:08.681Z",
    ...over,
  };
}

function stubFetch(body: unknown, ok = true): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("a hash resolves as direct without any network call", async () => {
  const { impl, calls } = stubFetch({});
  const result = await resolveSettlement(`0x${"ab".repeat(32)}`, { fetchImpl: impl });
  assert.equal(result.kind, "direct");
  assert.equal(calls.length, 0, "a hash needs no lookup");
});

test("a settled batch exposes the batch hash, never as a per-payment hash", async () => {
  const { impl } = stubFetch(transfer());
  const result = await resolveSettlement("05c7355d-f80d-4c1d-b79f-0ff7986cb57f", { fetchImpl: impl });
  assert.equal(result.kind, "batched");
  assert.ok("batchTxHash" in result && result.batchTxHash === BATCH);
  assert.ok(!("txHash" in result), "a batched settlement must not carry a field named txHash");
});

test("an unsettled transfer is pending, not a hash", async () => {
  const { impl } = stubFetch(transfer({ status: "batched", txHash: undefined }));
  const result = await resolveSettlement("05c7355d-f80d-4c1d-b79f-0ff7986cb57f", { fetchImpl: impl });
  assert.equal(result.kind, "pending");
  assert.ok(!("batchTxHash" in result));
});

test("a uuid is never returned in a hash field", async () => {
  const { impl } = stubFetch(transfer({ txHash: "05c7355d-f80d-4c1d-b79f-0ff7986cb57f" }));
  const result = await resolveSettlement("05c7355d-f80d-4c1d-b79f-0ff7986cb57f", { fetchImpl: impl });
  assert.equal(result.kind, "pending", "a non-hex txHash must not be treated as a hash");
});

test("lookups need no key: the request carries no auth and no signer", async () => {
  const { impl, calls } = stubFetch(transfer());
  await resolveSettlement("05c7355d-f80d-4c1d-b79f-0ff7986cb57f", { fetchImpl: impl });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("/x402/transfers/"), calls[0]);
  assert.ok(!calls[0].includes("key"), "no credential belongs in a lookup URL");
});

test("testnet is the default and mainnet is opt-in", async () => {
  const a = stubFetch(transfer());
  await resolveSettlement("05c7355d-f80d-4c1d-b79f-0ff7986cb57f", { fetchImpl: a.impl });
  assert.ok(a.calls[0].includes("gateway-api-testnet"), a.calls[0]);

  const b = stubFetch(transfer());
  await resolveSettlement("05c7355d-f80d-4c1d-b79f-0ff7986cb57f", { fetchImpl: b.impl, mainnet: true });
  assert.ok(!b.calls[0].includes("testnet"), b.calls[0]);
});

test("a failed request throws rather than reporting a false settlement", async () => {
  const { impl } = stubFetch({ message: "boom" }, false);
  await assert.rejects(() => resolveSettlement("05c7355d-f80d-4c1d-b79f-0ff7986cb57f", { fetchImpl: impl }));
});

test("paymentsInBatch returns only the payments that batch carried", async () => {
  const other = "0xc96673dac2eaeac245d2000000000000000000000000000000000000000000ab";
  const { impl } = stubFetch({
    transfers: [
      transfer({ id: "a" }),
      transfer({ id: "b" }),
      transfer({ id: "c", txHash: other }),
      transfer({ id: "d", txHash: undefined }),
    ],
  });
  const rows = await paymentsInBatch(
    { from: "0x1111111111111111111111111111111111111111", batchTxHash: BATCH, network: "eip155:5042002" },
    { fetchImpl: impl },
  );
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
});

test("paymentsInBatch handles a bare array response", async () => {
  const { impl } = stubFetch([transfer({ id: "a" })]);
  const rows = await paymentsInBatch(
    { from: "0x1111111111111111111111111111111111111111", batchTxHash: BATCH, network: "eip155:5042002" },
    { fetchImpl: impl },
  );
  assert.equal(rows.length, 1);
});

test("a malformed hash is not proof", async () => {
  for (const malformed of ["0x", "0xnot-a-tx-hash", "0xabc", `0x${"ab".repeat(31)}`]) {
    const { impl } = stubFetch(transfer({ txHash: malformed }));
    const result = await resolveSettlement("05c7355d-f80d-4c1d-b79f-0ff7986cb57f", { fetchImpl: impl });
    assert.equal(result.kind, "pending", `accepted "${malformed}" as a hash`);
  }
});

test("a malformed id is looked up, not assumed to be a hash", async () => {
  const { impl, calls } = stubFetch(transfer({ txHash: undefined, status: "batched" }));
  const result = await resolveSettlement("0xnotreal", { fetchImpl: impl });
  assert.equal(calls.length, 1, "should have performed a lookup");
  assert.equal(result.kind, "pending");
});

test("only a full 32-byte hash counts as direct", async () => {
  const { impl, calls } = stubFetch(transfer());
  const result = await resolveSettlement(`0x${"ab".repeat(32)}`, { fetchImpl: impl });
  assert.equal(result.kind, "direct");
  assert.equal(calls.length, 0);
});

test("paymentsInBatch follows pagination cursors", async () => {
  const other = `0x${"cd".repeat(32)}`;
  const pages = [
    { transfers: [transfer({ id: "a" }), transfer({ id: "x", txHash: other })], pagination: { pageAfter: "cur1" } },
    { transfers: [transfer({ id: "b" })], pagination: { next: "cur2" } },
    { transfers: [transfer({ id: "c" })] },
  ];
  let call = 0;
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    const body = pages[call] ?? { transfers: [] };
    call += 1;
    return { ok: true, status: 200, json: async () => body, text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;

  const rows = await paymentsInBatch(
    { from: "0x1111111111111111111111111111111111111111", batchTxHash: BATCH, network: "eip155:5042002" },
    { fetchImpl: impl },
  );
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c"], "should span all three pages");
  assert.ok(calls[1].includes("pageAfter=cur1"), calls[1]);
  assert.ok(calls[2].includes("pageAfter=cur2"), calls[2]);
});

test("paymentsInBatch stops at maxPages rather than walking forever", async () => {
  // Cursors advance every page, so only maxPages can end the walk.
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        transfers: [transfer({ id: `row${calls}` })],
        pagination: { pageAfter: `cursor${calls}` },
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const rows = await paymentsInBatch(
    { from: "0x1111111111111111111111111111111111111111", batchTxHash: BATCH, network: "eip155:5042002", maxPages: 3 },
    { fetchImpl: impl },
  );
  assert.equal(calls, 3);
  assert.equal(rows.length, 3, "each advancing page contributes a distinct payment");
});

test("the chain id colon is not percent-encoded", async () => {
  const { impl, calls } = stubFetch({ transfers: [] });
  await paymentsInBatch(
    { from: "0x1111111111111111111111111111111111111111", batchTxHash: BATCH, network: "eip155:5042002" },
    { fetchImpl: impl },
  );
  assert.ok(calls[0].includes("eip155:5042002"), calls[0]);
  assert.ok(!calls[0].includes("%3A"), calls[0]);
});

test("a cursor that does not advance stops the walk instead of refetching", async () => {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ transfers: [transfer({ id: "same" })], pagination: { next: "https://api/page?SAME" } }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const rows = await paymentsInBatch(
    { from: "0x1111111111111111111111111111111111111111", batchTxHash: BATCH, network: "eip155:5042002", maxPages: 5 },
    { fetchImpl: impl },
  );
  assert.equal(calls, 2, "should stop once the cursor repeats, not run to maxPages");
  assert.equal(rows.length, 1, "a repeated page must not count a payment twice");
});

test("a payment served on two different pages is counted once", async () => {
  const pages = [
    { transfers: [transfer({ id: "a" }), transfer({ id: "b" })], pagination: { pageAfter: "cur1" } },
    { transfers: [transfer({ id: "b" }), transfer({ id: "c" })] },
  ];
  let call = 0;
  const impl = (async () => {
    const body = pages[call] ?? { transfers: [] };
    call += 1;
    return { ok: true, status: 200, json: async () => body, text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;

  const rows = await paymentsInBatch(
    { from: "0x1111111111111111111111111111111111111111", batchTxHash: BATCH, network: "eip155:5042002" },
    { fetchImpl: impl },
  );
  assert.deepEqual(rows.map((r) => r.id).sort(), ["a", "b", "c"]);
});
