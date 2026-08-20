import test from "node:test";
import assert from "node:assert/strict";
import { BudgetAllocator, USDC, type Candidate } from "../src/allocator.js";

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const payee = (id: string, affinity: number, minAsk = 500): Candidate => ({ id, affinity, minAsk });

/** Runs a full session and reports what each payee received from each pool. */
function runSession(cfg: { budget: number; concentrationCap?: number; seed?: number; turns?: number }) {
  const allocator = new BudgetAllocator({
    budget: cfg.budget,
    concentrationCap: cfg.concentrationCap,
    rng: seeded(cfg.seed ?? 1),
  });
  const candidates = Array.from({ length: 6 }, (_, i) => payee(`p${i}`, 0.25 + 0.12 * i));
  const live = new Map<string, number>();
  // Completion is an independent observation, deliberately uncorrelated with affinity: deriving it
  // from the prior is the circular signal this allocator exists to avoid.
  const observe = seeded((cfg.seed ?? 1) * 31 + 7);

  for (let turn = 0; turn < (cfg.turns ?? 20); turn += 1) {
    for (const c of allocator.surface(candidates, 3)) {
      const decision = allocator.recommend(c);
      if (decision.accept) {
        const paid = allocator.commit(c, { amount: decision.amount, completion: observe() });
        live.set(c.id, (live.get(c.id) ?? 0) + paid);
      } else {
        allocator.skip(c);
      }
    }
  }
  const retro = new Map(allocator.finalize().map((s) => [s.id, s.amount]));
  return { allocator, candidates, live, retro };
}

test("never spends more than the budget", () => {
  for (const seed of [1, 7, 42, 99, 12345]) {
    const { live, retro } = runSession({ budget: 5 * USDC, seed });
    const total = [...live.values()].reduce((a, b) => a + b, 0) + [...retro.values()].reduce((a, b) => a + b, 0);
    assert.ok(total <= 5 * USDC, `seed ${seed}: spent ${total} of ${5 * USDC}`);
  }
});

test("live spend never exceeds the live budget", () => {
  const { allocator } = runSession({ budget: 5 * USDC, seed: 3 });
  const snap = allocator.snapshot();
  assert.ok(snap.liveSpent <= snap.liveBudget, `${snap.liveSpent} > ${snap.liveBudget}`);
});

test("the concentration cap holds across both pools", () => {
  for (const seed of [1, 7, 42, 99]) {
    const budget = 5 * USDC;
    const cap = 0.35;
    const { candidates, live, retro } = runSession({ budget, concentrationCap: cap, seed });
    const absolute = Math.floor(cap * budget);
    for (const c of candidates) {
      const total = (live.get(c.id) ?? 0) + (retro.get(c.id) ?? 0);
      assert.ok(total <= absolute, `seed ${seed}: ${c.id} got ${total}, cap ${absolute}`);
    }
  }
});

test("the retrospective split never exceeds the reserved pool", () => {
  const { allocator, retro } = runSession({ budget: 5 * USDC, seed: 11 });
  const paid = [...retro.values()].reduce((a, b) => a + b, 0);
  assert.ok(paid <= allocator.snapshot().reserved, `${paid} > ${allocator.snapshot().reserved}`);
});

test("clampBid refuses proposals that are not finite numbers", () => {
  const allocator = new BudgetAllocator({ budget: USDC, rng: seeded(1) });
  const c = payee("a", 0.9);
  for (const hostile of [NaN, Infinity, -Infinity, undefined as unknown as number, "500" as unknown as number]) {
    assert.equal(allocator.clampBid(c, hostile), 0, `accepted ${String(hostile)}`);
  }
});

test("clampBid holds a proposal inside [minAsk, ceiling]", () => {
  const allocator = new BudgetAllocator({ budget: USDC, perPaymentCap: 5_000, rng: seeded(1) });
  const c = payee("a", 0.9, 500);
  assert.equal(allocator.clampBid(c, 1), 500, "below minAsk should lift to minAsk");
  assert.equal(allocator.clampBid(c, 9_999_999), 5_000, "above ceiling should fall to ceiling");
  assert.equal(allocator.clampBid(c, 2_000), 2_000, "inside the range should pass through");
});

test("a hostile proposal cannot spend through commit", () => {
  const allocator = new BudgetAllocator({ budget: USDC, rng: seeded(1) });
  const paid = allocator.commit(payee("a", 0.9), { amount: NaN, completion: 1 });
  assert.equal(paid, 0);
  assert.equal(allocator.snapshot().liveSpent, 0);
});

test("every amount is an integer", () => {
  const { live, retro } = runSession({ budget: 5 * USDC, seed: 5 });
  for (const amount of [...live.values(), ...retro.values()]) {
    assert.ok(Number.isInteger(amount), `${amount} is not an integer`);
  }
});

test("refusals name the constraint that bound", () => {
  const allocator = new BudgetAllocator({ budget: 2_000, perPaymentCap: 1_000, rng: seeded(1) });
  const expensive = payee("a", 0.01, 999_999);
  const decision = allocator.recommend(expensive);
  assert.equal(decision.accept, false);
  assert.ok(decision.note.length > 0);
  assert.ok(
    ["budget exhausted", "concentration cap reached", "below ask"].includes(decision.note) ||
      decision.note.includes("lambda"),
    `unhelpful note: ${decision.note}`,
  );
});

test("finalize settles once, so a retrying caller cannot be paid twice", () => {
  const { allocator, retro } = runSession({ budget: 5 * USDC, seed: 2 });
  assert.ok(retro.size > 0, "fixture should produce a retro split");
  assert.deepEqual(allocator.finalize(), []);
  assert.deepEqual(allocator.finalize(), []);
});

test("finalize pays nothing when nothing was realized", () => {
  const allocator = new BudgetAllocator({ budget: USDC, rng: seeded(1) });
  allocator.skip(payee("a", 0.5));
  assert.deepEqual(allocator.finalize(), []);
});

test("the same seed reproduces the same session", () => {
  const a = runSession({ budget: 5 * USDC, seed: 77 });
  const b = runSession({ budget: 5 * USDC, seed: 77 });
  assert.deepEqual([...a.live.entries()].sort(), [...b.live.entries()].sort());
  assert.deepEqual([...a.retro.entries()].sort(), [...b.retro.entries()].sort());
});

test("different seeds produce different sessions", () => {
  const a = runSession({ budget: 5 * USDC, seed: 1 });
  const b = runSession({ budget: 5 * USDC, seed: 2 });
  assert.notDeepEqual([...a.live.entries()].sort(), [...b.live.entries()].sort());
});

test("the accept threshold rises when spending outruns the pace", () => {
  const allocator = new BudgetAllocator({ budget: 10 * USDC, horizon: 50, perPaymentCap: USDC, rng: seeded(4) });
  const c = payee("a", 0.99);
  for (let i = 0; i < 4; i += 1) {
    const d = allocator.recommend(c);
    if (d.accept) allocator.commit(c, { amount: d.amount, completion: 1 });
    else allocator.skip(c);
  }
  assert.ok(allocator.snapshot().lambda > 1, `lambda stayed at ${allocator.snapshot().lambda}`);
});

test("the accept threshold falls when spending lags the pace", () => {
  const allocator = new BudgetAllocator({ budget: 10 * USDC, horizon: 50, rng: seeded(4) });
  const c = payee("b", 0.5);
  for (let i = 0; i < 6; i += 1) allocator.skip(c);
  assert.ok(allocator.snapshot().lambda < 1, `lambda stayed at ${allocator.snapshot().lambda}`);
});

test("a deadband keeps the threshold still while spending tracks the pace", () => {
  const allocator = new BudgetAllocator({ budget: 10 * USDC, horizon: 50, perPaymentCap: 200_000, rng: seeded(4) });
  const c = payee("c", 0.99);
  for (let i = 0; i < 4; i += 1) {
    const d = allocator.recommend(c);
    if (d.accept) allocator.commit(c, { amount: d.amount, completion: 1 });
    else allocator.skip(c);
  }
  assert.equal(allocator.snapshot().lambda, 1, "small spend inside the band should not move lambda");
});

test("rejects a nonsensical configuration", () => {
  assert.throws(() => new BudgetAllocator({ budget: 0 }));
  assert.throws(() => new BudgetAllocator({ budget: USDC, reservedFraction: 1 }));
  assert.throws(() => new BudgetAllocator({ budget: USDC, concentrationCap: 0 }));
  assert.throws(() => new BudgetAllocator({ budget: USDC, horizon: 0 }));
  assert.throws(() => new BudgetAllocator({ budget: USDC, perPaymentCap: 0 }));
});

test("never pays below what a payee asked, even for a fractional ask", () => {
  const allocator = new BudgetAllocator({ budget: USDC, rng: seeded(1) });
  for (const ask of [1000.7, 1.9, 0.4]) {
    const c: Candidate = { id: `a${ask}`, affinity: 0.5, minAsk: ask };
    const paid = allocator.clampBid(c, ask);
    assert.ok(paid === 0 || paid >= ask, `ask ${ask} paid ${paid}`);
  }
});

test("an unpayable ask is refused rather than rounded away", () => {
  const allocator = new BudgetAllocator({ budget: USDC, rng: seeded(1) });
  for (const ask of [0, -5, NaN, Infinity]) {
    const c: Candidate = { id: `b${String(ask)}`, affinity: 0.5, minAsk: ask };
    assert.equal(allocator.clampBid(c, 5_000), 0, `ask ${String(ask)} was paid`);
    assert.equal(allocator.recommend(c).accept, false, `ask ${String(ask)} was accepted`);
  }
});
