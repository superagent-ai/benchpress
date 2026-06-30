/** Normalized objective signal from a benchmark grader (not a contender self-verdict). */
export type ObjectiveSignal = {
  outcome: 'true_positive' | 'false_positive' | 'false_negative' | 'true_negative';
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
