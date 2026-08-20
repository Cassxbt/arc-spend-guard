# arc-spend-guard

**Decide before you pay. Prove after you pay.** Two primitives for agents spending USDC on Arc.

![License: MIT](https://img.shields.io/badge/license-MIT-black) ![Zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-1ED760) ![node:test](https://img.shields.io/badge/tests-node%3Atest-6C5CE7)

```bash
npm install github:Cassxbt/arc-spend-guard
```

---

## What this exposes

**`BudgetAllocator`** — spends a scarce budget across payees that compete for it. Paces spend
against a horizon, caps how much any one payee can take, refuses with a named constraint, and
clamps every proposed amount at a single enforcement point. Zero dependencies, deterministic
under an injected RNG.

**`resolveSettlement` / `paymentsInBatch`** — answers what a payment id can actually prove.
A Gateway-batched payment has no transaction of its own, so this returns the hash of the batch
that carried it under a name that cannot be mistaken for one, and lists the other payments inside
that batch.

## What this adds over `circlefin/arc-*`

The Circle samples move USDC once a price is known. Neither question below is answered there.

| Already exists | What it does | What this adds |
|---|---|---|
| `arc-commerce` | 1 buyer → 1 merchant, price given | Chooses among payees competing for one budget |
| `arc-p2p-payments` | 1 sender → 1 receiver, gasless | A decision layer in front of any transfer |
| `arc-nanopayments` | Agent pays the seller's asking price; `--limit` pauses at a hard cap | A rising accept threshold, per-payee concentration caps, refusal with a reason |
| SDK `PayResult.transaction` | Typed `/** Transaction hash from settlement */`; returns a UUID when the payment is batched | A discriminated result that cannot put a UUID in a hash field |
| SDK `TransferResponse` | Omits `txHash`, which the HTTP response does return | Reads it, validates it is hex, and names it `batchTxHash` |

---

## Deciding

```ts
import { BudgetAllocator, USDC } from "arc-spend-guard";

const allocator = new BudgetAllocator({ budget: 5 * USDC });   // amounts are atomic USDC6

for (const candidate of allocator.surface(payees, 4)) {
  const decision = allocator.recommend(candidate);

  if (!decision.accept) {
    console.log(`refused ${candidate.id}: ${decision.note}`);   // "concentration cap reached"
    allocator.skip(candidate);
    continue;
  }

  await settle(candidate.id, decision.amount);
  allocator.commit(candidate, { amount: decision.amount, completion: playedFraction });
}

for (const { id, amount } of allocator.finalize()) await settle(id, amount);
```

### Propose, choose, clamp

The reason `clampBid` is separate from `recommend`: when a model picks the amount, the allocator
still decides what is legal. The caller proposes, the guard disposes.

```ts
const legal = allocator.clampBid(candidate, amountChosenByModel);
// out-of-range is pulled into range; NaN, Infinity, and non-numbers buy nothing
```

Every amount passes through that one method, including `commit`. There is no second path.

### What it guarantees

- Total spend never exceeds `budget`, and live spend never exceeds `budget × (1 − reservedFraction)`.
- No payee receives more than `concentrationCap × budget`, counting **both** the live pool and the
  retrospective split.
- `clampBid` returns a value in `[ceil(minAsk), ceiling]`, or `0` when nothing is affordable. A
  fractional ask rounds **up**, so a payee is never handed less than it asked for.
- `finalize()` settles once. A caller retrying after a partial payout is not paid twice.
- All amounts are integers, so nothing drifts.
- Identical seeds reproduce identical sessions.

Each is a test in `test/allocator.test.ts`.

### The threshold

A fixed budget means paying one payee raises the price of money for the next. `lambda` tracks
spend against a linear pace target with a deadband: spend ahead of pace and it climbs, so the same
offer that cleared at turn 3 is refused at turn 12. Spend behind pace and it relaxes.

It is a **pace controller**, not a dual variable from a solved program. Named honestly so nobody
expects an optimality guarantee it does not make.

---

## Proving

A batch settles many nanopayments in one transaction, which emits **one** Gateway event with no
per-recipient log. Nothing on chain identifies a single payment inside it. So the honest answer to
"where is my payment?" has three shapes, not one:

```ts
import { resolveSettlement, paymentsInBatch } from "arc-spend-guard";

const settlement = await resolveSettlement(paymentId);

switch (settlement.kind) {
  case "direct":  settlement.txHash;       // paid on its own transaction
  case "batched": settlement.batchTxHash;  // proves the batch, not this payment
  case "pending": settlement.status;       // accepted, no batch has carried it yet
}
```

`resolveSettlement` reads a public endpoint. It takes no key and constructs no signer, because a
lookup should never require custody of a funded wallet.

### Seeing inside a batch

The chain cannot tell you what a batch carried. The API can:

```ts
const payments = await paymentsInBatch({
  from: payerAddress,
  batchTxHash: settlement.batchTxHash,
  network: "eip155:5042002",
});
// → 16 payments to 7 payees, each with amount and recipient
```

This is a client-side join, and it needs `from` because Circle indexes transfers by payer rather
than by batch. Rarely a limit in practice: anything auditing its own spend already knows who paid.
There is deliberately no `paymentsInBatch(txHash)` overload — that would promise third-party batch
forensics the API cannot currently support.

---

## Provenance

Extracted from a production agent that allocates a scarce USDC budget across competing payees on
Arc. The figures above are real and checkable: batch
[`0xc0ba816a…`](https://testnet.arcscan.app/tx/0xc0ba816a46d8aad425bbd8b7fdcd3e197b53da96989c4feb8695ef9a43dad294)
carried 16 payments to 7 payees, and settled on Arc testnet.

## Development

```bash
npm test        # typechecks, then runs the suite on node:test
```

No runtime dependencies. TypeScript and `@types/node` are the only dev dependencies.

## License

MIT
