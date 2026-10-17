/** Intended location: evidence/submission/verify-public.mjs in the release copy. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const base = new URL('.', import.meta.url);
const root = new URL('../../', import.meta.url);
const prefix = 'evidence/submission/';
const historicalReportSha256 = '066a575b2e391b53966c4b657068db59b71c0b750b4c3db9741e96ed93aca8df';
const expectedRunId = '2026-10-16T06-25-59-472Z-92b4ec36-83c0-4df6-96dc-f8ae4bc72c7a';
const expectedToolCallId = 'call_00_VFrZkZJR8v9gX3TFZJjb6547';
const expectedDate = '2026-10-15';
const publishedNames = ['acceptance.md', 'http-acceptance.json', 'pi-events.jsonl', 'provenance.json',
  'run-summary.json', 'tool-executions.jsonl', 'verification.json', 'verify.mjs'];
const implementationPaths = ['src/agent/evidence.ts', 'scripts/smoke-audit-checks.ts', 'src/agent/tools.ts'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checks = [];
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: 'FAIL',
  scope: 'published-selected-artifacts-only',
  command: 'node --import tsx evidence/submission/verify-public.mjs',
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  rawSourceRead: false,
  sourceHashStatus: 'NOT_RECOMPUTED_ORIGINALS_NOT_INCLUDED',
  sourceTransformationStatus: 'HISTORICAL_DECLARATION_NOT_REPRODUCED',
  httpBodyHashStatus: 'NOT_RECOMPUTED_BODY_NOT_INCLUDED',
  modelRequestsMade: 0,
  limitations: [
    'PASS applies only to integrity and consistency of the published selected artifacts and the executed existing validators.',
    'Original evidence/local files are not read or supplied. Their hashes and the three summary-field omissions remain historical provenance statements; this run cannot reproduce that source-to-derivative comparison.',
    'The selected JSONL and HTTP files have hashes equal to their declared byte-identical sources, but the original files are not independently reopened.',
    'HTTP metadata contains historical comparison assertions and body hashes, not complete original request/response bodies. Those body hashes and full-body comparisons are not recomputed.',
    'The recorded Pi session/model/status fields describe the historical run. This command creates no new session, model request, tool execution or web server and supplies no independent provider attestation.',
    'Hashes detect changes relative to the pinned historical report; they are not a signature by the model provider.',
  ],
};
function expect(id, passed) {
  checks.push({ id, passed: passed === true });
  if (passed !== true) throw new Error(id);
}
function readAllowed(relative, allowed) {
  expect(`allowed_input:${relative}`, allowed.includes(relative));
  try { return readFileSync(new URL(relative, root)); }
  catch { throw new Error(`input_unavailable:${relative}`); }
}
function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`invalid_json:${label}`); }
}
function parseJsonl(bytes, label) {
  const lines = bytes.toString('utf8').trim().split(/\r?\n/);
  return lines.map((line) => parseJson(Buffer.from(line), label));
}

try {
  // Direct filesystem inputs are limited to these eight published files and three implementations.
  const allowedEvidencePaths = publishedNames.map((name) => prefix + name);
  const files = new Map(publishedNames.map((name) => [name, readAllowed(prefix + name, allowedEvidencePaths)]));
  expect('pinned_historical_report_sha256', sha256(files.get('verification.json')) === historicalReportSha256);
  const historical = parseJson(files.get('verification.json'), 'verification.json');
  const provenance = parseJson(files.get('provenance.json'), 'provenance.json');
  const summary = parseJson(files.get('run-summary.json'), 'run-summary.json');
  const events = parseJsonl(files.get('pi-events.jsonl'), 'pi-events.jsonl');
  const executions = parseJsonl(files.get('tool-executions.jsonl'), 'tool-executions.jsonl');
  const http = parseJson(files.get('http-acceptance.json'), 'http-acceptance.json');
  expect('historical_report_seven_artifact_entries', Array.isArray(historical.artifacts) && historical.artifacts.length === 7
    && isDeepStrictEqual(historical.artifacts.map((item) => item.path).sort(),
      allowedEvidencePaths.filter((path) => !path.endsWith('/verification.json')).sort()));
  for (const entry of historical.artifacts) {
    const name = entry.path.slice(prefix.length);
    const bytes = files.get(name);
    expect(`published_artifact_hash:${name}`, bytes.length === entry.bytes && sha256(bytes) === entry.sha256);
  }
  report.artifacts = publishedNames.map((name) => ({ path: prefix + name,
    bytes: files.get(name).length, sha256: sha256(files.get(name)) }));
  expect('three_validator_implementation_entries', Array.isArray(provenance.verifierImplementations)
    && isDeepStrictEqual(provenance.verifierImplementations.map((entry) => entry.path).sort(), [...implementationPaths].sort()));
  for (const entry of provenance.verifierImplementations) {
    const bytes = readAllowed(entry.path, implementationPaths);
    expect(`validator_implementation_hash:${entry.path}`, bytes.length === entry.bytes && sha256(bytes) === entry.sha256);
  }
  report.verifierImplementations = provenance.verifierImplementations;

  // Compare recorded source declarations only. Never resolve or open a provenance.source.path.
  expect('four_provenance_mappings', Array.isArray(provenance.files) && provenance.files.length === 4);
  expect('recorded_source_metadata_consistent', provenance.files.every((entry) => historical.sourceIntegrity.some((recorded) =>
    recorded.path === entry.source.path && recorded.bytes === entry.source.bytes && recorded.sha256 === entry.source.sha256)));
  for (const entry of provenance.files) {
    const name = entry.derivative.path.slice(prefix.length);
    expect(`declared_derivative_path:${name}`, entry.derivative.path === prefix + name && files.has(name));
    const bytes = files.get(name);
    expect(`provenance_derivative_hash:${name}`, bytes.length === entry.derivative.bytes && sha256(bytes) === entry.derivative.sha256);
  }
  const originalSummary = provenance.files.find((entry) => entry.derivative.path === prefix + 'run-summary.json');
  expect('recorded_summary_source_hash_agrees_with_http_trace', http.trace.hashes['summary.json'] === originalSummary.source.sha256);
  expect('declared_byte_copy_source_hashes_agree_with_published_bytes', provenance.files
    .filter((entry) => entry.derivative.path !== prefix + 'run-summary.json')
    .every((entry) => entry.source.sha256 === entry.derivative.sha256 && entry.source.bytes === entry.derivative.bytes));
  for (const name of ['pi-events.jsonl', 'tool-executions.jsonl']) {
    expect(`http_trace_matches_published_log_hash:${name}`, http.trace.hashes[name] === sha256(files.get(name)));
  }
  expect('declared_summary_omissions_absent', ['prompt', 'evidenceDirectory', 'summaryPath', 'events', 'executions']
    .every((key) => !Object.hasOwn(summary, key)));

  // These existing modules define validators; no runAuditAgent/session/tool execution is invoked.
  let collectAuditToolResults, evaluateAuditSmoke;
  try {
    ({ collectAuditToolResults } = await import('../../src/agent/evidence.ts'));
    ({ evaluateAuditSmoke } = await import('../../scripts/smoke-audit-checks.ts'));
  } catch { throw new Error('validator_import_failed_check_installed_project_dependencies_and_tsx'); }
  const captures = collectAuditToolResults(summary.runId, events, executions);
  expect('collector_one_complete_call_equal_to_summary', captures.length === 1 && isDeepStrictEqual(captures, summary.toolResults));
  const capture = captures[0];
  expect('expected_run_call_tool_exact_arguments', summary.runId === expectedRunId && summary.date === expectedDate
    && capture.toolCallId === expectedToolCallId && capture.toolName === 'audit_day'
    && isDeepStrictEqual(capture.args, { date: expectedDate }));
  const smoke = evaluateAuditSmoke({ runId: summary.runId, sessionCreated: summary.sessionCreated,
    activeTools: summary.activeTools, events, executions, finalAnswer: summary.finalAnswer,
    finalStopReason: summary.finalStopReason ?? undefined });
  expect('existing_smoke_fifteen_of_fifteen', smoke.length === 15 && smoke.every((entry) => entry.passed));
  report.existingValidators = { collectedCalls: captures.length, smokePassed: smoke.filter((entry) => entry.passed).length,
    smokeTotal: smoke.length, smokeChecks: smoke };
  expect('recorded_model_session_normal_end', summary.status === 'PASS' && summary.sessionCreated === true
    && summary.provider === 'deepseek' && summary.modelId === 'deepseek-flash'
    && summary.finalStopReason === 'stop' && summary.error === null);
  expect('summary_record_counts', events.length === 2 && executions.length === 2
    && summary.eventCount === 2 && summary.executeRecordCount === 2
    && isDeepStrictEqual(summary.toolCallIds, [expectedToolCallId]));
  const ordered = [...events, ...executions].sort((a, b) => a.sequence - b.sequence);
  expect('four_phases_sequences_one_to_four', isDeepStrictEqual(ordered.map(({ sequence, phase }) => [sequence, phase]), [
    [1, 'tool_execution_start'], [2, 'execute_start'], [3, 'execute_end'], [4, 'tool_execution_end'],
  ]));
  const runtime = events.find((entry) => entry.phase === 'tool_execution_end').result;
  const execute = executions.find((entry) => entry.phase === 'execute_end').result;
  expect('runtime_single_text_result', runtime.content.length === 1 && runtime.content[0].type === 'text');
  const runtimeText = parseJson(Buffer.from(runtime.content[0].text), 'runtime_text');
  expect('runtime_text_details_execute_and_summary_full_results_equal', isDeepStrictEqual(runtimeText, execute)
    && isDeepStrictEqual(runtime.details, execute) && isDeepStrictEqual(capture.result, execute));
  expect('summary_warnings_equal_tool_result', isDeepStrictEqual(summary.warnings, capture.result.warnings));
  const counts = Object.fromEntries(['matched', 'field_mismatch', 'missing_recording', 'orphan_recording', 'needs_review']
    .map((status) => [status, capture.result.results.filter((group) => group.status === status).length]));
  expect('seven_groups_and_expected_distribution', capture.result.results.length === 7
    && isDeepStrictEqual(counts, { matched: 1, field_mismatch: 1, missing_recording: 1, orphan_recording: 1, needs_review: 3 }));
  expect('http_post_date_status_run_groups_and_distribution', http.request.method === 'POST' && http.request.path === '/api/audit'
    && http.request.date === expectedDate && http.response.date === expectedDate
    && http.response.http_status === 200 && http.response.status === 'PASS'
    && http.response.runId === expectedRunId && http.trace.runId === expectedRunId
    && http.response.results_length === capture.result.results.length && isDeepStrictEqual(http.response.status_counts, counts)
    && isDeepStrictEqual(http.trace.calls, [{ toolCallId: expectedToolCallId, toolName: 'audit_day', args: { date: expectedDate } }])
    && http.trace.runtime_events === events.length && http.trace.execute_records === executions.length);
  expect('historical_http_body_hashes_are_retained_hash_strings', /^[a-f0-9]{64}$/.test(http.request.body_sha256)
    && /^[a-f0-9]{64}$/.test(http.response.body_sha256));
  expect('http_window_encloses_recorded_run_and_phases', Date.parse(http.request.started_at) <= Date.parse(summary.startedAt)
    && Date.parse(summary.endedAt) <= Date.parse(http.response.ended_at)
    && ordered.every((entry) => Date.parse(summary.startedAt) <= Date.parse(entry.timestamp)
      && Date.parse(entry.timestamp) <= Date.parse(summary.endedAt)));
  report.recordedRun = { runId: summary.runId, date: summary.date, recordedStatus: summary.status,
    sessionCreated: summary.sessionCreated, provider: summary.provider, modelId: summary.modelId,
    finalStopReason: summary.finalStopReason, toolCallId: capture.toolCallId, toolName: capture.toolName,
    args: capture.args, resultGroups: capture.result.results.length, statusCounts: counts, httpStatus: http.response.http_status };
  report.historicalSourceStatements = { status: 'RETAINED_NOT_RECOMPUTED',
    recordedMetadataConsistent: true, sources: provenance.files.map(({ source }) => source),
    omittedSummaryFields: ['prompt', 'evidenceDirectory', 'summaryPath'] };
  report.status = 'PASS';
} catch (error) {
  // Only our own relative-path/identifier messages are exposed; loader/OS errors may contain machine paths.
  const ownFailure = checks.findLast((entry) => !entry.passed)?.id;
  const controlled = error instanceof Error && /^(?:input_unavailable:|invalid_json:|validator_import_failed_)/.test(error.message);
  report.failure = ownFailure ?? (controlled ? error.message : 'selected_evidence_verification_failed');
}
report.checks = { passed: checks.filter((entry) => entry.passed).length, total: checks.length, items: checks };
if (process.argv.includes('--write')) {
  try { writeFileSync(fileURLToPath(new URL('verification-public.json', base)), JSON.stringify(report, null, 2) + '\n'); }
  catch { report.status = 'FAIL'; report.failure = 'public_report_write_failed'; }
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'PASS' ? 0 : 1;
