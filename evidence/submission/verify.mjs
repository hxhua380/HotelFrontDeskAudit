/** Local historical-evidence verification only: no session, model request or server. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { collectAuditToolResults } from '../../src/agent/evidence.ts';
import { evaluateAuditSmoke } from '../../scripts/smoke-audit-checks.ts';

const directory = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(directory, '../..');
const runId = '2026-10-16T06-25-59-472Z-92b4ec36-83c0-4df6-96dc-f8ae4bc72c7a';
const toolCallId = 'call_00_VFrZkZJR8v9gX3TFZJjb6547';
const date = '2026-10-15';
const expectedCounts = { matched: 1, field_mismatch: 1, missing_recording: 1, orphan_recording: 1, needs_review: 3 };
const omitted = ['prompt', 'evidenceDirectory', 'summaryPath'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const read = (path) => readFileSync(resolve(root, path));
const parse = (path) => JSON.parse(read(path));
const jsonl = (path) => read(path).toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
const checks = [];
const check = (id, passed) => checks.push({ id, passed: passed === true });
const noPrivateValues = (value, path = '$', findings = []) => {
  if (Array.isArray(value)) value.forEach((item, index) => noPrivateValues(item, `${path}[${index}]`, findings));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret)$/i.test(key)
        && item !== null && item !== '') findings.push(`${path}.${key}`);
      noPrivateValues(item, `${path}.${key}`, findings);
    }
  } else if (typeof value === 'string' && (
    /\bsk-[A-Za-z0-9_-]{12,}\b/.test(value)
    || /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9_.-]{8,}/i.test(value)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)
    || /(?:^|[\s"'(])[A-Za-z]:[\\/]/.test(value)
    || /file:\/\//i.test(value)
    || /https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value)
    || /\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/i.test(value)
  )) findings.push(path);
  return findings;
};
const smokeInput = (summary, events, executions) => ({
  runId: summary.runId, sessionCreated: summary.sessionCreated, activeTools: summary.activeTools,
  events, executions, finalAnswer: summary.finalAnswer, finalStopReason: summary.finalStopReason ?? undefined,
});
const statusCounts = (capture) => Object.fromEntries(Object.keys(expectedCounts).map((status) => [
  status, capture.result.results.filter((group) => group.status === status).length,
]));

const provenance = parse('evidence/submission/provenance.json');
const sources = provenance.files.map((entry) => {
  const bytes = read(entry.source.path);
  const current = { path: entry.source.path, bytes: bytes.length, sha256: sha256(bytes) };
  check(`source_hash:${entry.source.path}`, current.sha256 === entry.source.sha256 && current.bytes === entry.source.bytes);
  const derivative = read(entry.derivative.path);
  check(`derivative_hash:${entry.derivative.path}`, sha256(derivative) === entry.derivative.sha256 && derivative.length === entry.derivative.bytes);
  return current;
});
for (const artifact of provenance.authoredArtifacts) {
  const bytes = read(artifact.path);
  check(`authored_artifact_hash:${artifact.path}`, sha256(bytes) === artifact.sha256 && bytes.length === artifact.bytes);
}
for (const implementation of provenance.verifierImplementations) {
  check(`validator_implementation_hash:${implementation.path}`, sha256(read(implementation.path)) === implementation.sha256);
}

const sourcePath = `evidence/local/stage4/${runId}/`;
const original = parse(`${sourcePath}summary.json`);
const originalEvents = jsonl(`${sourcePath}pi-events.jsonl`);
const originalExecutions = jsonl(`${sourcePath}tool-executions.jsonl`);
const originalHttp = parse('evidence/local/stage6-fix/http-audit-2026-10-15.json');
const summary = parse('evidence/submission/run-summary.json');
const events = jsonl('evidence/submission/pi-events.jsonl');
const executions = jsonl('evidence/submission/tool-executions.jsonl');
const http = parse('evidence/submission/http-acceptance.json');
const minimized = structuredClone(original);
omitted.forEach((key) => delete minimized[key]);
check('summary_only_declared_fields_omitted', isDeepStrictEqual(summary, minimized));
check('summary_contains_no_duplicate_event_arrays', !Object.hasOwn(summary, 'events') && !Object.hasOwn(summary, 'executions'));
for (const name of ['pi-events.jsonl', 'tool-executions.jsonl']) {
  check(`raw_log_bytes_preserved:${name}`, read(`${sourcePath}${name}`).equals(read(`evidence/submission/${name}`)));
}
check('http_metadata_bytes_preserved', read('evidence/local/stage6-fix/http-audit-2026-10-15.json').equals(read('evidence/submission/http-acceptance.json')));
const scanFindings = [summary, events, executions, http].flatMap((value, index) => noPrivateValues(value, `$artifact[${index}]`));
check('reviewed_business_json_has_no_detected_credentials_auth_or_absolute_local_path', scanFindings.length === 0);

// Both calls below run the existing production collector, once for each evidence set.
const sourceCaptures = collectAuditToolResults(original.runId, originalEvents, originalExecutions);
const captures = collectAuditToolResults(summary.runId, events, executions);
const sourceSmoke = evaluateAuditSmoke(smokeInput(original, originalEvents, originalExecutions));
const derivativeSmoke = evaluateAuditSmoke(smokeInput(summary, events, executions));
check('source_collects_exactly_one_complete_call', sourceCaptures.length === 1 && isDeepStrictEqual(sourceCaptures, original.toolResults));
check('derivative_collects_exactly_one_complete_call', captures.length === 1 && isDeepStrictEqual(captures, summary.toolResults));
check('source_and_derivative_captures_equal', isDeepStrictEqual(captures, sourceCaptures));
check('source_smoke_15_of_15', sourceSmoke.length === 15 && sourceSmoke.every((item) => item.passed));
check('derivative_smoke_15_of_15', derivativeSmoke.length === 15 && derivativeSmoke.every((item) => item.passed));
check('recorded_session_provider_model_and_stop', summary.sessionCreated === true && summary.provider === 'deepseek'
  && summary.modelId === 'deepseek-flash' && summary.finalStopReason === 'stop' && summary.status === 'PASS' && summary.error === null);
check('expected_run_call_tool_and_exact_arguments', captures.length === 1 && summary.runId === runId && summary.date === date
  && captures[0].toolCallId === toolCallId && captures[0].toolName === 'audit_day'
  && isDeepStrictEqual(captures[0].args, { date }) && isDeepStrictEqual(summary.toolCallIds, [toolCallId]));
const ordered = [...events, ...executions].sort((a, b) => a.sequence - b.sequence);
check('four_phases_sequences_1_2_3_4', ordered.length === 4 && isDeepStrictEqual(ordered.map((item) => [item.sequence, item.phase]), [
  [1, 'tool_execution_start'], [2, 'execute_start'], [3, 'execute_end'], [4, 'tool_execution_end'],
]) && ordered.every((item) => item.runId === runId && item.toolCallId === toolCallId
  && item.toolName === 'audit_day' && isDeepStrictEqual(item.args, { date })));
check('summary_event_counts_equal_jsonl', summary.eventCount === events.length && events.length === 2
  && summary.executeRecordCount === executions.length && executions.length === 2);
const runtimeEnd = events.find((item) => item.phase === 'tool_execution_end');
const executeEnd = executions.find((item) => item.phase === 'execute_end');
let runtimeTextMatches = false;
try {
  const content = runtimeEnd.result.content;
  runtimeTextMatches = content.length === 1 && content[0].type === 'text'
    && isDeepStrictEqual(JSON.parse(content[0].text), executeEnd.result);
} catch { /* A missing/non-JSON response is a failed check, never a repaired record. */ }
check('runtime_text_details_execute_and_summary_full_results_equal', runtimeTextMatches
  && isDeepStrictEqual(runtimeEnd.result.details, executeEnd.result)
  && isDeepStrictEqual(summary.toolResults[0]?.result, executeEnd.result));
const counts = captures[0] ? statusCounts(captures[0]) : {};
check('seven_groups_distribution_1_1_1_1_3', captures.length === 1 && captures[0].result.results.length === 7
  && isDeepStrictEqual(counts, expectedCounts));
check('summary_warnings_match_full_tool_result', captures.length === 1 && isDeepStrictEqual(summary.warnings, captures[0].result.warnings)
  && summary.warnings.length === 0);
check('http_post_date_status_runid_groups_and_distribution', http.request.method === 'POST' && http.request.path === '/api/audit'
  && http.request.date === date && http.response.http_status === 200 && http.response.status === 'PASS'
  && http.response.date === date && http.response.runId === runId && http.trace.runId === runId
  && http.response.results_length === 7 && isDeepStrictEqual(http.response.status_counts, counts)
  && isDeepStrictEqual(http.trace.calls, [{ toolCallId, toolName: 'audit_day', args: { date } }])
  && http.trace.runtime_events === events.length && http.trace.execute_records === executions.length);
check('http_historical_trace_hashes_match_original_files', ['summary.json', 'pi-events.jsonl', 'tool-executions.jsonl']
  .every((name) => http.trace.hashes[name] === sha256(read(`${sourcePath}${name}`))));
check('http_window_encloses_recorded_agent_and_phases', Date.parse(http.request.started_at) <= Date.parse(summary.startedAt)
  && Date.parse(summary.endedAt) <= Date.parse(http.response.ended_at)
  && ordered.every((item) => Date.parse(summary.startedAt) <= Date.parse(item.timestamp)
    && Date.parse(item.timestamp) <= Date.parse(summary.endedAt)));
check('http_body_hashes_preserved_metadata_only', /^[a-f0-9]{64}$/.test(http.request.body_sha256)
  && /^[a-f0-9]{64}$/.test(http.response.body_sha256)
  && http.request.body_sha256 === originalHttp.request.body_sha256
  && http.response.body_sha256 === originalHttp.response.body_sha256);

const artifacts = ['run-summary.json', 'pi-events.jsonl', 'tool-executions.jsonl', 'http-acceptance.json', 'provenance.json', 'acceptance.md', 'verify.mjs'].map((name) => {
  const bytes = read(`evidence/submission/${name}`);
  return { path: `evidence/submission/${name}`, bytes: bytes.length, sha256: sha256(bytes) };
});
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: checks.every((item) => item.passed) ? 'PASS' : 'FAIL',
  method: 'Offline revalidation of unchanged historical source evidence and its declared derivative; no new Pi session, model request or web server.',
  command: 'node --import tsx evidence/submission/verify.mjs',
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  run: {
    runId: summary.runId, date: summary.date, recordedStatus: summary.status,
    sessionCreated: summary.sessionCreated, provider: summary.provider, modelId: summary.modelId,
    activeTools: summary.activeTools, finalStopReason: summary.finalStopReason,
    toolCallId, toolName: 'audit_day', args: captures[0]?.args ?? null,
    window_seconds: captures[0]?.result.window_seconds ?? null,
    resultGroups: captures[0]?.result.results.length ?? 0, statusCounts: counts,
    httpStatus: http.response.http_status, recordedStartedAt: summary.startedAt, recordedEndedAt: summary.endedAt,
    sequence: ordered.map(({ sequence, phase, timestamp, isError }) => ({ sequence, phase, timestamp, isError })),
    finalAnswerSha256: sha256(summary.finalAnswer),
  },
  checks: { passed: checks.filter((item) => item.passed).length, total: checks.length, items: checks },
  existingValidators: {
    source: { collectedCalls: sourceCaptures.length, smokePassed: sourceSmoke.filter((item) => item.passed).length, smokeTotal: sourceSmoke.length, smokeChecks: sourceSmoke },
    derivative: { collectedCalls: captures.length, smokePassed: derivativeSmoke.filter((item) => item.passed).length, smokeTotal: derivativeSmoke.length, smokeChecks: derivativeSmoke },
  },
  privacyScan: { scope: 'Parsed derivative summary, both JSONL files and HTTP metadata; pattern and field-name checks plus documented manual review.', detectedPaths: scanFindings },
  sourceIntegrity: sources,
  artifacts,
  verifierImplementations: provenance.verifierImplementations,
  limitations: [
    'The HTTP artifact contains historical request/response metadata, comparison assertions and body hashes; the complete original request/response bodies are not retained here. No fresh full-body comparison or recomputation of those body hashes is claimed.',
    'This is a local consistency/provenance check of a recorded real online run, not a new online acceptance run or an independent cryptographic attestation by the model provider.',
    'Credential/path pattern scanning is limited to these selected text artifacts and does not establish that arbitrary future inputs are safe.',
    'The verification report omits its own hash to avoid a self-reference; calculate that hash from the final file when packaging.',
  ],
};
if (process.argv.includes('--write')) writeFileSync(resolve(directory, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === 'PASS' ? 0 : 1;
