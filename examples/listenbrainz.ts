/**
 * ListenBrainz `submit-listens` as a usage event source.
 *
 * Self-hosted media servers already emit telemetry. Navidrome, Funkwhale, Airsonic, Gonic and
 * Maloja all speak the ListenBrainz wire, so implementing the protocol reaches all of them at once
 * rather than writing a connector per platform. Point a server at this with one setting:
 *
 *   ND_LISTENBRAINZ_BASEURL=https://your-host
 *
 * This is an example of turning an event stream into allocator input. It is not the package.
 */

export interface UsageEvent {
  /** Stable id for the thing being paid for. */
  payeeKey: string;
  /** Deduplication key. The same listen submitted twice must not pay twice. */
  idempotencyKey: string;
  /** 0..1, how much of the item was consumed. Feeds `commit({ completion })`. */
  completion: number;
  at: number;
}

interface ListenPayload {
  listen_type?: "single" | "playing_now" | "import";
  payload?: Array<{
    listened_at?: number;
    track_metadata?: {
      artist_name?: string;
      track_name?: string;
      additional_info?: { recording_mbid?: string; duration_ms?: number };
    };
  }>;
}

/**
 * Parses a `submit-listens` body into usage events.
 *
 * `playing_now` is dropped: it announces a track that started, not one that finished, and paying
 * on it would pay for a skip.
 */
export function parseListenBrainz(body: ListenPayload): UsageEvent[] {
  if (body.listen_type === "playing_now") return [];

  return (body.payload ?? []).flatMap((listen) => {
    const meta = listen.track_metadata;
    const artist = meta?.artist_name?.trim();
    if (!artist) return [];

    const at = (listen.listened_at ?? Math.floor(Date.now() / 1000)) * 1000;
    const recording = meta?.additional_info?.recording_mbid ?? meta?.track_name ?? "unknown";

    return [
      {
        payeeKey: artist,
        idempotencyKey: `${artist}:${recording}:${listen.listened_at ?? at}`,
        completion: 1,
        at,
      },
    ];
  });
}

/**
 * Wiring sketch: an event stream on one side, the allocator on the other.
 *
 *   const events = parseListenBrainz(req.body);
 *   for (const event of events) {
 *     if (seen.has(event.idempotencyKey)) continue;
 *     const candidate = { id: event.payeeKey, affinity: taste(event.payeeKey), minAsk: 500 };
 *     const decision = allocator.recommend(candidate);
 *     if (!decision.accept) { allocator.skip(candidate); continue; }
 *     await settle(candidate.id, decision.amount);
 *     allocator.commit(candidate, { amount: decision.amount, completion: event.completion });
 *     seen.add(event.idempotencyKey);
 *   }
 *
 * Settle before commit, and record the idempotency key only after both succeed, so a crash
 * between them replays rather than silently dropping the payment.
 */
