import { spawn } from 'node:child_process';
import { EXPECTED_BACKENDS } from '../adapter-loader.mjs';
import { ENV_BASE } from '../core/adapter-env.mjs';
import { scrubEnv } from '../core/env.mjs';
import { resolveBinaryName } from './doctor.mjs';
import { listBackendModels, parseModelListing } from './models.mjs';

// Advisory only: this command never writes config, sessions, defaults, or the ledger.
// It collects the live model listings, asks the Jev model (via command-code) how well each
// candidate fits the task, and prints a ranked table. Nothing is applied.
const MAX_CANDIDATES = 12;
const JEV_MODEL = 'typesafe/jev';
const JEV_BINARY = 'command-code';

function buildJevRequest(task, candidate) {
  return JSON.stringify({
    state: { task, candidate },
    questions: {
      fit: {
        type: 'noul',
        instructions: `Is ${candidate} a good fit for this task: ${task}? Answer yes or no.`,
      },
    },
  });
}

// Spawn with an argument array (never a shell string) so the task text cannot be
// interpreted as shell syntax. stdin is /dev/null ('ignore'); stdout carries the Jev JSON.
function runJev(binary, payload) {
  return new Promise((resolve) => {
    const child = spawn(binary, ['-p', payload, '-m', JEV_MODEL], {
      env: scrubEnv(ENV_BASE),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => resolve({ error }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// The probability is answers.fit.noul, a number in [0, 1] (probability the answer is yes).
// Tolerate backends that bracket the object with extra chatter by also trying the first
// '{' through the last '}'. Returns null when no usable number can be recovered.
export function parseJevProbability(stdout) {
  const attempts = [stdout.trim()];
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start !== -1 && end > start) attempts.push(stdout.slice(start, end + 1));
  for (const attempt of attempts) {
    let value;
    try {
      value = JSON.parse(attempt)?.answers?.fit?.noul;
    } catch {
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
      return value;
    }
  }
  return null;
}

// confidence = max(p, 1-p): p >= 0.9 (confidence >= 0.9, p on the yes side) recommends;
// p <= 0.1 (confidence >= 0.9, p on the no side) refuses; anything in between is uncertain.
function verdictFor(p) {
  const confidence = Math.max(p, 1 - p);
  if (confidence < 0.9) return 'uncertain, re-evaluate';
  return p >= 0.5 ? 'recommended' : 'not recommended';
}

async function collectCandidates(adapters) {
  const candidates = [];
  const seen = new Set();
  let capped = false;
  for (const name of EXPECTED_BACKENDS) {
    const adapter = adapters[name];
    if (!adapter || typeof adapter.listModels !== 'function') continue;
    const result = await listBackendModels(name, adapter);
    if (result.kind !== 'listing') {
      if (result.kind === 'unavailable') {
        console.error(`pick: skipping ${name} — ${result.reason}`);
      }
      continue;
    }
    if (result.code !== 0) {
      console.error(`pick: skipping ${name} — model listing failed (exit ${result.code})`);
      continue;
    }
    for (const model of parseModelListing(result.out)) {
      if (seen.has(model)) continue;
      seen.add(model);
      if (candidates.length < MAX_CANDIDATES) {
        candidates.push(model);
      } else {
        capped = true;
      }
    }
  }
  return { candidates, capped };
}

export async function cmdPick(adapters, taskDescription) {
  if (typeof taskDescription !== 'string' || taskDescription.trim() === '') {
    console.error("usage: cli-relay pick '<task description>'");
    process.exitCode = 2;
    return;
  }
  const task = taskDescription.trim();

  const { candidates, capped } = await collectCandidates(adapters);
  if (capped) {
    console.error(`pick: more than ${MAX_CANDIDATES} candidates found — capped at ${MAX_CANDIDATES}`);
  }
  if (candidates.length === 0) {
    console.error('pick: no model candidates found (no available backend exposes a listing command)');
    process.exitCode = 1;
    return;
  }

  const jevBinary = await resolveBinaryName([JEV_BINARY]);
  if (!jevBinary) {
    console.error(`pick: ${JEV_BINARY} not found on PATH — cannot call the Jev model`);
  }

  const results = [];
  for (const candidate of candidates) {
    if (!jevBinary) {
      console.error(`pick: ${candidate}: ${JEV_BINARY} not found on PATH`);
      continue;
    }
    const response = await runJev(jevBinary, buildJevRequest(task, candidate));
    if (response.error) {
      console.error(`pick: ${candidate}: Jev call failed (${response.error.message})`);
      continue;
    }
    if (response.code !== 0) {
      console.error(`pick: ${candidate}: Jev call failed (exit ${response.code})`);
      continue;
    }
    const p = parseJevProbability(response.out);
    if (p === null) {
      console.error(`pick: ${candidate}: Jev returned unparseable output`);
      continue;
    }
    results.push({ candidate, p });
  }

  results.sort((left, right) => right.p - left.p);
  const width = Math.max('candidate'.length, ...results.map((result) => result.candidate.length));
  console.log(`${'candidate'.padEnd(width)}  p     verdict`);
  for (const result of results) {
    console.log(`${result.candidate.padEnd(width)}  ${result.p.toFixed(2)}  ${verdictFor(result.p)}`);
  }
  console.log('advisory only, nothing was applied');

  process.exitCode = results.length > 0 ? 0 : 1;
}
