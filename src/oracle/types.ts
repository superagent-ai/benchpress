/** Normalized objective signal from a benchmark grader (not a contender self-verdict). */
export type ObjectiveSignal = {
  /**
   * `excluded` is for a grader that deliberately declines to render a TP/FP/FN/TN verdict --
   * e.g. cybergym's differential oracle coming back "inconclusive" (the vulnerable-side replay
   * itself didn't reproduce cleanly, so there is nothing to compare against the patched side),
   * or a benchmark with no reproduction artifact compatible with its oracle for a given
   * contender type. Contributes zero to every `OracleScore` count -- specifically not
   * `false_negative`, which would wrongly penalize a claim the grader never actually evaluated.
   */
  outcome: 'true_positive' | 'false_positive' | 'false_negative' | 'true_negative' | 'excluded';
  matched: boolean;
  reason: string;
  metadata?: Record<string, unknown>;
};

export type OracleScore = {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  signals: ObjectiveSignal[];
  /**
   * Dollar value associated with this score, for benchmarks that weight
   * outcomes by real-world bounty/award value (e.g. BountyBench). Undefined
   * for benchmarks with no dollar dimension; summed across true positives
   * only by convention (a benchmark's `score()` decides what counts).
   */
  dollarValue?: number;
};

export function emptyOracleScore(): OracleScore {
  return { truePositives: 0, falsePositives: 0, falseNegatives: 0, trueNegatives: 0, signals: [] };
}

export function aggregateOracleScores(scores: OracleScore[]): OracleScore {
  return scores.reduce(
    (acc, score) => ({
      truePositives: acc.truePositives + score.truePositives,
      falsePositives: acc.falsePositives + score.falsePositives,
      falseNegatives: acc.falseNegatives + score.falseNegatives,
      trueNegatives: acc.trueNegatives + score.trueNegatives,
      signals: [...acc.signals, ...score.signals],
      dollarValue:
        acc.dollarValue === undefined && score.dollarValue === undefined
          ? undefined
          : (acc.dollarValue ?? 0) + (score.dollarValue ?? 0),
    }),
    emptyOracleScore(),
  );
}

export function youdenIndex(score: OracleScore): number {
  const tp = score.truePositives;
  const fp = score.falsePositives;
  const fn = score.falseNegatives;
  const tn = score.trueNegatives;
  const tprDenom = tp + fn;
  const fprDenom = fp + tn;
  if (tprDenom === 0 || fprDenom === 0) return 0;
  const tpr = tp / tprDenom;
  const fpr = fp / fprDenom;
  return tpr - fpr;
}
