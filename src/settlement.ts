export type Hex = `0x${string}`;

export type TransferStatus = "received" | "batched" | "confirmed" | "completed" | "failed";

export type Settlement =
  /** Paid on its own transaction. The hash is this payment. */
  | { kind: "direct"; txHash: Hex }
  /**
   * Carried by a batch that settled on chain. `batchTxHash` proves the batch, not this payment:
   * the batch emits a single Gateway event with no per-recipient log, so there is nothing on
   * chain that identifies one payment inside it. Use `paymentsInBatch` to enumerate the rest.
   */
  | { kind: "batched"; id: string; status: TransferStatus; batchTxHash: Hex }
  /** Accepted by Gateway, not yet carried by a settled batch. */
  | { kind: "pending"; id: string; status: TransferStatus };

export interface TransferRecord {
  id: string;
  status: TransferStatus;
  token: string;
  sendingNetwork: string;
  recipientNetwork: string;
  fromAddress: string;
  toAddress: string;
  /** Atomic USDC6, as a string. */
  amount: string;
  nonce?: string;
  /**
   * The batch transaction that carried this payment. Circle's API returns it; the published SDK
   * types do not declare it, which is why callers reach for `PayResult.transaction` instead and
   * end up holding a UUID they believe is a hash.
   */
  txHash?: string;
  createdAt: string;
  updatedAt: string;
}

const TESTNET = "https://gateway-api-testnet.circle.com/v1";
const MAINNET = "https://gateway-api.circle.com/v1";

export interface ResolveOptions {
  /** Defaults to testnet. */
  mainnet?: boolean;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function baseUrl(opts?: ResolveOptions): string {
  return opts?.mainnet ? MAINNET : TESTNET;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

// A 32-byte hash, not merely something beginning "0x". Circle returns `txHash` untyped, so a
// malformed or placeholder value must fall through to `pending` rather than be handed on as proof.
function isTxHash(value: unknown): value is Hex {
  return typeof value === "string" && TX_HASH.test(value);
}

async function getJson<T>(url: string, opts?: ResolveOptions): Promise<T> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const response = await doFetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Gateway request failed (${response.status}): ${await response.text().catch(() => response.statusText)}`);
  }
  return (await response.json()) as T;
}

/**
 * Resolves what a payment id can actually prove. Reads a public endpoint, so it needs no key and
 * no signer: a lookup should never require custody of a funded wallet.
 */
export async function resolveSettlement(id: string, opts?: ResolveOptions): Promise<Settlement> {
  if (isTxHash(id)) return { kind: "direct", txHash: id };

  const transfer = await getJson<TransferRecord>(
    `${baseUrl(opts)}/x402/transfers/${encodeURIComponent(id)}`,
    opts,
  );
  const status = transfer.status;
  return isTxHash(transfer.txHash)
    ? { kind: "batched", id, status, batchTxHash: transfer.txHash }
    : { kind: "pending", id, status };
}

export interface PaymentsInBatchQuery {
  /** Payer address. Required: Circle indexes transfers by payer, not by batch. */
  from: string;
  batchTxHash: Hex;
  network: string;
  pageSize?: number;
  /** Stop after this many pages. Default 20, which is a guard against an unbounded walk. */
  maxPages?: number;
}

interface TransfersPage {
  transfers?: TransferRecord[];
  pagination?: { next?: string; pageAfter?: string };
}

/**
 * Lists the payments a batch carried. The chain cannot answer this — one batch emits one event
 * with no per-recipient log — so it is a client-side join over the payer's transfers.
 *
 * Requires `from` because the API offers no filter on the batch hash. Rarely a limitation in
 * practice: a caller auditing its own spend already knows who paid.
 */
export async function paymentsInBatch(
  query: PaymentsInBatchQuery,
  opts?: ResolveOptions,
): Promise<TransferRecord[]> {
  const wanted = query.batchTxHash.toLowerCase();
  const found = new Map<string, TransferRecord>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < (query.maxPages ?? 20); page += 1) {
    const params = new URLSearchParams({ from: query.from, network: query.network });
    if (query.pageSize) params.set("pageSize", String(query.pageSize));
    if (cursor) params.set("pageAfter", cursor);

    // Gateway rejects a percent-encoded chain id, so the colon in eip155:N is restored.
    const url = `${baseUrl(opts)}/x402/transfers?${params.toString().replaceAll("%3A", ":")}`;
    const body = await getJson<TransfersPage | TransferRecord[]>(url, opts);

    const rows = Array.isArray(body) ? body : (body.transfers ?? []);
    if (rows.length === 0) break;
    // Keyed by transfer id: a page served twice must not count a payment twice.
    for (const row of rows) {
      if (row.txHash?.toLowerCase() === wanted) found.set(row.id, row);
    }

    cursor = Array.isArray(body) ? undefined : (body.pagination?.pageAfter ?? body.pagination?.next);
    // A cursor that does not advance would otherwise refetch the same page until maxPages.
    if (!cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
  }

  return [...found.values()];
}
