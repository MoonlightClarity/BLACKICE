// Independently verify every source identity used by the recursive Directory benchmark.
// An absent/misspelled digest is a mismatch, never grounds for discarding a valid trial.
export function recursionBenchmarkProvenanceMismatches(report, source, expected) {
  const pairs = [
    ['sourceRoot', report?.sourceRoot, source?.root],
    ['directoryImplementationSha256', report?.directoryImplementationSha256, source?.digests?.directory],
    ['harnessEngineSha256', report?.harnessEngineSha256, source?.digests?.engine],
    ['workspaceToolSha256', report?.workspaceToolSha256, source?.digests?.workspace],
    ['benchmarkDriverSha256', report?.benchmarkDriverSha256, expected?.driver],
    ['benchmarkWorkflowSha256', report?.benchmarkWorkflowSha256, expected?.workflow],
    ['benchmarkFixtureSha256', report?.benchmarkFixtureSha256, expected?.codeFixture],
    ['longEvidenceFixtureSha256', report?.longEvidenceFixtureSha256, expected?.longEvidenceFixture],
  ];
  return pairs.filter(([, actual, required]) => typeof required !== 'string'
    || required.length === 0 || actual !== required).map(([name]) => name);
}
