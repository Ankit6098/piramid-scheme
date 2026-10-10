/**
 * Interprets `reward_calculations.trace` (written by `serializeTrace` in reward-calculator.ts) for
 * the admin calculation-trace view. Defensive: traces are stored JSON and may come from an older
 * engine version, so unknown shapes degrade to `parsed: false` instead of throwing. Pure.
 */

export interface ParsedTraceLevel {
  level: number;
  decision: string;
  userId: string | null;
  depth: number | null;
  calcType: 'FIXED' | 'PERCENTAGE' | null;
  percentageBps: number | null;
  fixedAmountMinor: string | null;
  capMinor: string | null;
  ruleAmountMinor: string | null;
  amountMinor: string | null;
  capped: boolean;
  budgetLimited: boolean;
  remainingBudgetMinor: string | null;
  reason: string | null;
}

export interface ParsedTraceAncestor {
  userId: string;
  depth: number;
  eligible: boolean;
  reason: string | null;
}

export interface ParsedTrace {
  parsed: boolean;
  engineVersion: string | null;
  saleAmountMinor: string | null;
  baseNote: string | null;
  baseMinor: string | null;
  budgetBps: number | null;
  budgetMinor: string | null;
  maxTotalPerEventMinor: string | null;
  totalAllocatedMinor: string | null;
  policyVersion: number | null;
  levels: ParsedTraceLevel[];
  ancestors: ParsedTraceAncestor[];
  warnings: string[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
/** Minor amounts are stored as decimal strings; accept integers too. */
const minor = (v: unknown): string | null => {
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  return null;
};

const EMPTY: ParsedTrace = {
  parsed: false,
  engineVersion: null,
  saleAmountMinor: null,
  baseNote: null,
  baseMinor: null,
  budgetBps: null,
  budgetMinor: null,
  maxTotalPerEventMinor: null,
  totalAllocatedMinor: null,
  policyVersion: null,
  levels: [],
  ancestors: [],
  warnings: [],
};

export function parseRewardTrace(raw: unknown): ParsedTrace {
  if (!isObj(raw) || !Array.isArray(raw.steps)) return { ...EMPTY };
  const steps = raw.steps.filter(isObj);
  const base = steps.find((s) => s.step === 'base');
  const budget = steps.find((s) => s.step === 'budget');

  const levels: ParsedTraceLevel[] = steps
    .filter((s) => s.step === 'level' && int(s.level) !== null)
    .map((s) => {
      const d = isObj(s.detail) ? s.detail : {};
      const calcType = d.calcType === 'FIXED' || d.calcType === 'PERCENTAGE' ? d.calcType : null;
      return {
        level: int(s.level)!,
        decision: str(s.decision) ?? 'UNKNOWN',
        userId: str(d.userId),
        depth: int(d.depth),
        calcType,
        percentageBps: int(d.percentageBps),
        fixedAmountMinor: minor(d.fixedAmountMinor),
        capMinor: minor(d.capMinor),
        ruleAmountMinor: minor(d.ruleAmountMinor),
        amountMinor: minor(d.amountMinor),
        capped: d.capped === true,
        budgetLimited: d.budgetLimited === true,
        remainingBudgetMinor: minor(d.remainingBudgetMinor),
        reason: str(d.reason),
      };
    });

  const ancestors: ParsedTraceAncestor[] = (Array.isArray(raw.ancestorsConsidered) ? raw.ancestorsConsidered : [])
    .filter(isObj)
    .flatMap((a) => {
      const userId = str(a.userId);
      const depth = int(a.depth);
      if (!userId || depth === null) return [];
      return [{ userId, depth, eligible: a.eligible === true, reason: str(a.reason) }];
    })
    .sort((x, y) => x.depth - y.depth);

  return {
    parsed: true,
    engineVersion: str(raw.engineVersion),
    saleAmountMinor: base ? minor(base.saleAmountMinor) : null,
    baseNote: base ? str(base.note) : null,
    baseMinor: minor(raw.baseMinor) ?? (base ? minor(base.baseMinor) : null),
    budgetBps: budget ? int(budget.budgetBps) : null,
    budgetMinor: minor(raw.budgetMinor) ?? (budget ? minor(budget.budgetMinor) : null),
    maxTotalPerEventMinor: budget ? minor(budget.maxTotalPerEventMinor) : null,
    totalAllocatedMinor: minor(raw.totalAllocatedMinor),
    policyVersion: int(raw.policyVersion),
    levels: levels.sort((x, y) => x.level - y.level),
    ancestors,
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).filter((w): w is string => typeof w === 'string'),
  };
}

/** Every member id referenced by the trace (to resolve display names). */
export function traceUserIds(trace: ParsedTrace): string[] {
  const ids = new Set<string>();
  for (const l of trace.levels) if (l.userId) ids.add(l.userId);
  for (const a of trace.ancestors) ids.add(a.userId);
  return [...ids];
}
