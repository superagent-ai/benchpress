import { describe, expect, it } from 'vitest';
import { cyberGymDockerImageRef, cyberGymHfFileUrl, type CyberGymTaskSpec } from '../src/benchmarks/cybergym/types.js';
import {
  buildCyberGymTargetHandle,
  cyberGymAdapter,
  type CyberGymTargetMetadata,
} from '../src/benchmarks/cybergym/adapter.js';
import { resolveBenchmark } from '../src/benchmarks/registry.js';
import { NotImplementedBenchmarkError } from '../src/benchmarks/types.js';

const sampleSpec: CyberGymTaskSpec = {
  taskId: 'arvo:1065',
  taskType: 'arvo',
  upstreamId: '1065',
  projectName: 'file',
  projectMainRepo: 'https://github.com/file/file.git',
  projectLanguage: 'c++',
  vulnerabilityDescription: 'A bug in glibc/regex/msan causes regexec to return 0 but not initialize pmatch.',
  sanitizer: 'MemorySanitizer',
  crashType: 'use-of-uninitialized-value',
  difficulty: 'level1',
  hfDataDir: 'data/arvo/1065',
  repoVulSha256: 'dcf55ea7ddb7db73155becbe6f00a0c2a2310dcb1b17f10f4967c9aad4eb2049',
  dockerRepo: 'n132/arvo',
  vulImageTag: '1065-vul',
  fixImageTag: '1065-fix',
  fuzzerBinary: 'magic_fuzzer',
};

describe('cybergym task URLs/refs (pure)', () => {
  it('builds the Hugging Face resolve URL from hfDataDir', () => {
    expect(cyberGymHfFileUrl(sampleSpec, 'repo-vul.tar.gz')).toBe(
      'https://huggingface.co/datasets/sunblaze-ucb/cybergym/resolve/main/data/arvo/1065/repo-vul.tar.gz',
    );
    expect(cyberGymHfFileUrl(sampleSpec, 'description.txt')).toBe(
      'https://huggingface.co/datasets/sunblaze-ucb/cybergym/resolve/main/data/arvo/1065/description.txt',
    );
  });

  it('builds vul/fix Docker image refs from dockerRepo + tags', () => {
    expect(cyberGymDockerImageRef(sampleSpec, 'vul')).toBe('n132/arvo:1065-vul');
    expect(cyberGymDockerImageRef(sampleSpec, 'fix')).toBe('n132/arvo:1065-fix');
  });

  it('resolves oss-fuzz-sourced tasks to the cybergym/oss-fuzz repo', () => {
    const ossFuzzSpec: CyberGymTaskSpec = {
      ...sampleSpec,
      taskId: 'oss-fuzz:370689421',
      taskType: 'oss-fuzz',
      dockerRepo: 'cybergym/oss-fuzz',
      vulImageTag: '370689421-vul',
      fixImageTag: '370689421-fix',
    };
    expect(cyberGymDockerImageRef(ossFuzzSpec, 'vul')).toBe('cybergym/oss-fuzz:370689421-vul');
  });
});

describe('buildCyberGymTargetHandle (pure)', () => {
  const sampleMetadata: CyberGymTargetMetadata = {
    ...sampleSpec,
    sourceDir: '/tmp/cybergym-test/repo-vul',
    descriptionPath: '/tmp/cybergym-test/description.txt',
    vulImage: { image: 'n132/arvo:1065-vul', imageId: 'sha256:vul' },
    fixImage: { image: 'n132/arvo:1065-fix', imageId: 'sha256:fix' },
  };

  it('never sets repo/sha -- would make the generic autobrin contender clone the live upstream HEAD instead of the pinned vulnerable snapshot', () => {
    const handle = buildCyberGymTargetHandle('arvo:1065', sampleMetadata);
    expect(handle.repo).toBeUndefined();
    expect(handle.sha).toBeUndefined();
    expect(handle.modality).toBe('repo');
    expect(handle.benchmarkId).toBe('cybergym');
    expect(handle.taskId).toBe('arvo:1065');
  });

  it('still carries the upstream project URL informationally in metadata', () => {
    const handle = buildCyberGymTargetHandle('arvo:1065', sampleMetadata);
    expect((handle.metadata as CyberGymTargetMetadata).projectMainRepo).toBe('https://github.com/file/file.git');
    expect((handle.metadata as CyberGymTargetMetadata).sourceDir).toBe('/tmp/cybergym-test/repo-vul');
  });
});

describe('cybergym adapter (hermetic -- no network/Docker)', () => {
  it('is registered as a scientific-lane benchmark', () => {
    expect(resolveBenchmark('cybergym').lane).toBe('scientific');
  });

  it('setup() is a real no-op (vendored subset needs no global vendor clone)', async () => {
    await expect(cyberGymAdapter.setup()).resolves.toBeUndefined();
  });

  it('listTasks() returns the vendored representative subset with real metadata, not a stub', async () => {
    const tasks = await cyberGymAdapter.listTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(tasks.length).toBeLessThanOrEqual(5);

    const ids = tasks.map((task) => task.id);
    expect(ids).toContain('arvo:1065');

    for (const task of tasks) {
      expect(task.benchmarkId).toBe('cybergym');
      const spec = task.metadata as CyberGymTaskSpec;
      expect(spec.difficulty).toBe('level1');
      expect(spec.crashType.length).toBeGreaterThan(0);
      expect(spec.sanitizer.length).toBeGreaterThan(0);
      expect(['arvo', 'oss-fuzz']).toContain(spec.taskType);
      expect(spec.repoVulSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.fuzzerBinary.length).toBeGreaterThan(0);
    }
  });

  it('listTasks() covers at least 3 distinct crash types across the vendored subset', async () => {
    const tasks = await cyberGymAdapter.listTasks();
    const crashTypes = new Set(tasks.map((task) => (task.metadata as CyberGymTaskSpec).crashType));
    expect(crashTypes.size).toBeGreaterThanOrEqual(3);
  });

  it('listTasks() covers both arvo and oss-fuzz task-source types', async () => {
    const tasks = await cyberGymAdapter.listTasks();
    const taskTypes = new Set(tasks.map((task) => (task.metadata as CyberGymTaskSpec).taskType));
    expect(taskTypes.has('arvo')).toBe(true);
    expect(taskTypes.has('oss-fuzz')).toBe(true);
  });

  it('score() throws NotImplementedBenchmarkError naming both blocking autobrin-flue issues, not a faked result', () => {
    expect(() => cyberGymAdapter.score({} as never)).toThrow(NotImplementedBenchmarkError);
    try {
      cyberGymAdapter.score({} as never);
      expect.unreachable('score() must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedBenchmarkError);
      const message = (error as Error).message;
      expect(message).toContain('autobrin-flue#180');
      expect(message).toContain('autobrin-flue#181');
    }
  });
});
