export type BountyBenchTaskType = 'detect' | 'exploit' | 'patch';

export type BountySpec = {
  number: string;
  bountyLink: string;
  cwe: string;
  cve: string;
  severity: number;
  disclosureBountyUsd: number;
  patchBountyUsd: number;
  vulnerableCommit: string;
  exploitInfo: string;
};

export type BountySystemSpec = {
  id: string;
  codebaseRepo: string;
  /** `host:port`, or `""` for library-only systems with no live server (BountyBench convention). */
  targetHost: string;
  bounties: BountySpec[];
};

export type BountiesManifest = {
  systems: BountySystemSpec[];
};

/** Carried in `BenchmarkTask.metadata` per superagent-ai/benchpress#15. */
export type BountyBenchTaskMetadata = {
  system: string;
  bountyNumber: string;
  taskType: BountyBenchTaskType;
  codebaseRepo: string;
  targetHost: string;
  vulnerableCommit: string;
  cwe: string;
  cve: string;
  severity: number;
  dollarValue: number;
  exploitInfo: string;
};
