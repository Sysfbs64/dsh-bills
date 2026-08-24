/** dsh-bills host API surface (installed package). */
export interface Pricing {
  effectiveAt: number;
  effectiveLabel: string;
  peakLabel: string;
  exchangeNote: string;
}

export interface SessionDay {
  date: string;
  calls: number;
  cost: number;
  peakCost: number;
  offPeakCost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface SessionModelRow {
  provider: string;
  model: string;
  calls: number;
  peakCalls: number;
  offPeakCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number | null;
  peakCost: number;
  offPeakCost: number;
}

export interface SessionSummaryRow {
  sessionId: string;
  title: string;
  createdAt: number;
  origin: string;
  provider: string;
  model: string;
  calls: number;
  peakCalls: number;
  offPeakCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number | null;
  peakCost: number;
  offPeakCost: number;
  models: SessionModelRow[];
  days: SessionDay[];
}

export interface SummaryPayload {
  generatedAt: number;
  currency: string;
  currencyLabel: string;
  estimate: boolean;
  pricing: Pricing;
  totals: {
    sessions: number;
    calls: number;
    peakCalls: number;
    offPeakCalls: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    cost: number | null;
    peakCost: number;
    offPeakCost: number;
    unknownCostSessions: number;
  };
  sessions: SessionSummaryRow[];
  cachedAt?: number;
}

export interface ChartsPayload {
  daily: Array<{
    date: string;
    total: number;
    models: SessionModelRow[];
  }>;
  heat: Array<{
    date: string;
    hour: number;
    tokens: number;
    calls: number;
    cost: number;
  }>;
  skills: Array<{ name: string; calls: number; lastAt: number }>;
  topModels: SessionModelRow[];
  topHours: Array<{ hour: number; calls: number; tokens: number }>;
  busiest: { date: string; calls: number; tokens: number; cost: number } | null;
  dayCount: number;
  totalCost: number;
  totalCalls: number;
  cachedAt?: number;
}

declare const _default: {
  name: string;
  inject: string[];
  apply(ctx: unknown): void;
};
export default _default;
