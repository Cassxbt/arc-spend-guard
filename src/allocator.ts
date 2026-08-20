type Rng = () => number;

/**
 * All amounts are USDC atomic units: 1 USDC = 1_000_000. Integers throughout, so a budget can
 * never be overspent by accumulated float error. Ratios (lambda, caps, weights) stay fractional.
 */
export const USDC = 1_000_000;

export interface AllocatorConfig {
  /** Total spendable budget, atomic USDC6. */
  budget: number;
  /** Share held back for the retrospective split. Default 0.2. */
  reservedFraction?: number;
  /** Turns the pace controller aims to spread the live budget over. Default 15. */
  horizon?: number;
  /** Ceiling on any single payment, atomic USDC6. Default 10_000 (one cent). */
  perPaymentCap?: number;
  /** Share of total budget any one payee may receive. Default 0.35. */
  concentrationCap?: number;
  weights?: ValueWeights;
  /** Multiplicative step the accept threshold moves by each turn. Default 0.08. */
  lambdaStep?: number;
  rng?: Rng;
}

export interface ValueWeights {
  affinity: number;
  novelty: number;
  quality: number;
}

export interface Candidate {
  id: string;
  /** Caller's prior belief this payee is worth paying, 0..1. */
  affinity: number;
  /** Lowest amount this payee will accept, atomic USDC6. */
  minAsk: number;
}

export interface Decision {
  accept: boolean;
  /** Atomic USDC6. Zero when refused. */
  amount: number;
  value: number;
  lambda: number;
  ceiling: number;
  budgetRemaining: number;
  /** Why it was accepted, or which constraint bound. */
  note: string;
}

interface PayeeState {
  alpha: number;
  beta: number;
  trials: number;
  spent: number;
  realized: number;
  affinity: number;
}

const PRIOR_STRENGTH = 2;
const SURFACE_EXPLORE = 0.45;
const SURFACE_AFFINITY = 0.35;
const SURFACE_NOVELTY = 0.2;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function gaussian(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Marsaglia-Tsang gamma sampler; Beta(a,b) = G(a) / (G(a) + G(b)).
function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) return sampleGamma(shape + 1, rng) * Math.pow(rng(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = gaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(a: number, b: number, rng: Rng): number {
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  return x / (x + y);
}

function weightSum(w: ValueWeights): number {
  return w.affinity + w.novelty + w.quality;
}

/**
 * A payee's ask in whole atomic units, rounded up. Rounding a fractional ask down would pay less
 * than was asked for. Zero means unpayable, which callers treat as a refusal.
 */
function askOf(c: Candidate): number {
  if (!Number.isFinite(c.minAsk) || c.minAsk <= 0) return 0;
  return Math.ceil(c.minAsk);
}

/**
 * Spends a scarce budget across payees that compete for it. Paying one raises the price of money
 * for every later choice, so the same offer can clear early in a session and be refused late.
 */
export class BudgetAllocator {
  private readonly rng: Rng;
  private readonly budget: number;
  private readonly reservedFraction: number;
  private readonly horizon: number;
  private readonly concentrationCap: number;
  private readonly lambdaStep: number;
  private readonly payees = new Map<string, PayeeState>();

  private weights: ValueWeights;
  private perPaymentCap: number;
  private lambda = 1;
  private liveSpent = 0;
  private steps = 0;
  private settled = false;

  constructor(cfg: AllocatorConfig) {
    this.rng = cfg.rng ?? Math.random;
    this.budget = Math.floor(cfg.budget);
    this.reservedFraction = cfg.reservedFraction ?? 0.2;
    this.horizon = cfg.horizon ?? 15;
    this.perPaymentCap = Math.floor(cfg.perPaymentCap ?? 10_000);
    this.concentrationCap = cfg.concentrationCap ?? 0.35;
    this.weights = cfg.weights ?? { affinity: 0.5, novelty: 0.2, quality: 0.3 };
    this.lambdaStep = cfg.lambdaStep ?? 0.08;

    if (!(this.budget > 0)) throw new Error("budget must be > 0 atomic units");
    if (this.reservedFraction < 0 || this.reservedFraction >= 1) throw new Error("reservedFraction must be in [0, 1)");
    if (this.horizon < 1) throw new Error("horizon must be >= 1");
    if (!(this.perPaymentCap > 0)) throw new Error("perPaymentCap must be > 0");
    if (this.concentrationCap <= 0 || this.concentrationCap > 1) throw new Error("concentrationCap must be in (0, 1]");
    if (!(weightSum(this.weights) > 0)) throw new Error("value weights must sum to > 0");
  }

  /**
   * Ranks candidates for consideration, blending a Thompson draw with affinity and novelty.
   * Ranking only: this does not decide or price a payment. Stochastic, so runs differ.
   */
  surface(candidates: Candidate[], k: number): Candidate[] {
    return candidates
      .map((c) => {
        const s = this.stateOf(c);
        const explore = sampleBeta(s.alpha, s.beta, this.rng);
        const novelty = 1 / (1 + s.trials);
        return { c, score: SURFACE_EXPLORE * explore + SURFACE_AFFINITY * s.affinity + SURFACE_NOVELTY * novelty };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((r) => r.c);
  }

  /** Prices one candidate against the current threshold. Refusals name the constraint that bound. */
  recommend(c: Candidate): Decision {
    const s = this.stateOf(c);
    const value = this.computeValue(s);
    const ask = askOf(c);
    const willingToPay = Math.floor(value * this.perPaymentCap);
    const budgetRemaining = this.liveBudget() - this.liveSpent;
    const ceiling = this.ceilingFor(s);

    if (ask === 0) return this.refusal(value, ceiling, budgetRemaining, "minAsk must be a positive number of atomic units");
    if (ceiling < ask) return this.refusal(value, ceiling, budgetRemaining, this.bindingConstraint(s, ask));
    if (willingToPay / ask < this.lambda) {
      return this.refusal(
        value,
        ceiling,
        budgetRemaining,
        `value/ask ${(willingToPay / ask).toFixed(2)} < lambda ${this.lambda.toFixed(2)}`,
      );
    }

    const amount = clamp(Math.floor(willingToPay / this.lambda), ask, ceiling);
    return {
      accept: true,
      amount,
      value,
      lambda: this.lambda,
      ceiling,
      budgetRemaining,
      note: `value ${value.toFixed(2)} at lambda ${this.lambda.toFixed(2)}`,
    };
  }

  /**
   * The single enforcement point. Callers propose; this disposes. A proposal that is not a finite
   * number buys nothing, so an untrusted proposer cannot spend by emitting garbage.
   */
  clampBid(c: Candidate, requested: number): number {
    if (!Number.isFinite(requested)) return 0;
    const ask = askOf(c);
    if (ask === 0) return 0;
    const ceiling = this.ceilingFor(this.stateOf(c));
    if (ceiling < ask) return 0;
    return Math.floor(clamp(requested, ask, ceiling));
  }

  /** Records a payment. Returns the amount actually allowed, which may be less than requested. */
  commit(c: Candidate, outcome: { amount: number; completion: number }): number {
    const s = this.stateOf(c);
    const completion = clamp(outcome.completion, 0, 1);
    const amount = this.clampBid(c, outcome.amount);
    if (amount > 0) {
      s.spent += amount;
      s.alpha += completion;
      s.beta += 1 - completion;
      s.realized += completion;
      this.liveSpent += amount;
    }
    s.trials += 1;
    this.tick();
    return amount;
  }

  /** Records a refusal. Time still passes, so the threshold still moves. */
  skip(c: Candidate): void {
    this.stateOf(c).trials += 1;
    this.tick();
  }

  /**
   * Splits the reserved pool by realized value. The concentration cap spans both pools, so a payee
   * already at it earns nothing here, and the split settles once so a retrying caller can't
   * double-pay.
   */
  finalize(): Array<{ id: string; amount: number }> {
    if (this.settled) return [];
    this.settled = true;
    const reserved = Math.floor(this.reservedFraction * this.budget);
    const totalRealized = [...this.payees.values()].reduce((sum, s) => sum + s.realized, 0);
    if (totalRealized <= 0) return [];
    return [...this.payees.entries()]
      .filter(([, s]) => s.realized > 0)
      .map(([id, s]) => {
        const share = Math.floor(reserved * (s.realized / totalRealized));
        const headroom = Math.max(0, Math.floor(this.concentrationCap * this.budget) - s.spent);
        return { id, amount: Math.min(share, headroom) };
      })
      .filter((split) => split.amount > 0);
  }

  /** Lets a caller revise strategy mid-session, e.g. lean more exploratory. */
  setStrategy(next: { weights?: ValueWeights; perPaymentCap?: number }): void {
    if (next.weights) {
      if (!(weightSum(next.weights) > 0)) throw new Error("value weights must sum to > 0");
      this.weights = next.weights;
    }
    if (next.perPaymentCap !== undefined) {
      if (!(next.perPaymentCap > 0)) throw new Error("perPaymentCap must be > 0");
      this.perPaymentCap = Math.floor(next.perPaymentCap);
    }
  }

  snapshot(): { lambda: number; liveSpent: number; liveBudget: number; reserved: number } {
    return {
      lambda: this.lambda,
      liveSpent: this.liveSpent,
      liveBudget: this.liveBudget(),
      reserved: Math.floor(this.reservedFraction * this.budget),
    };
  }

  private liveBudget(): number {
    return Math.floor((1 - this.reservedFraction) * this.budget);
  }

  private ceilingFor(s: PayeeState): number {
    return Math.min(
      this.perPaymentCap,
      Math.floor(this.concentrationCap * this.budget) - s.spent,
      this.liveBudget() - this.liveSpent,
    );
  }

  private bindingConstraint(s: PayeeState, ask: number): string {
    if (this.liveBudget() - this.liveSpent < ask) return "budget exhausted";
    if (Math.floor(this.concentrationCap * this.budget) - s.spent < ask) return "concentration cap reached";
    return "below ask";
  }

  private refusal(value: number, ceiling: number, budgetRemaining: number, note: string): Decision {
    return { accept: false, amount: 0, value, lambda: this.lambda, ceiling, budgetRemaining, note };
  }

  private computeValue(s: PayeeState): number {
    const { affinity, novelty, quality } = this.weights;
    const posterior = s.alpha / (s.alpha + s.beta);
    const novel = 1 / (1 + s.trials);
    return (affinity * s.affinity + novelty * novel + quality * posterior) / weightSum(this.weights);
  }

  // Tracks spend against a linear pace target. A deadband stops the threshold chattering.
  private tick(): void {
    this.steps += 1;
    const target = (this.liveBudget() / this.horizon) * Math.min(this.steps, this.horizon);
    const band = 0.05 * this.liveBudget();
    if (this.liveSpent > target + band) this.lambda *= 1 + this.lambdaStep;
    else if (this.liveSpent < target - band) this.lambda *= 1 - this.lambdaStep;
    this.lambda = clamp(this.lambda, 0.1, 10);
  }

  private stateOf(c: Candidate): PayeeState {
    let s = this.payees.get(c.id);
    if (!s) {
      const affinity = Number.isFinite(c.affinity) ? clamp(c.affinity, 0, 1) : 0;
      s = {
        alpha: 1 + PRIOR_STRENGTH * affinity,
        beta: 1 + PRIOR_STRENGTH * (1 - affinity),
        trials: 0,
        spent: 0,
        realized: 0,
        affinity,
      };
      this.payees.set(c.id, s);
    }
    return s;
  }
}
