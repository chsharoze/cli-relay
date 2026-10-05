import { readFileSync } from 'node:fs';
import {
  checkApproval, recordApproval, validateVerdict, VERDICTS,
} from '../governance/approval.mjs';

const RECORD_USAGE =
  'usage: cli-relay loop record <thread> --plan <path> --repo <path> --reviewer <backend> ' +
  `--verdict <${VERDICTS.join('|')}> --summary "<text>" [--model <model>] ` +
  '[--files <path,path>] [--coverage "<text>"] [--limitations "<text>"] ' +
  '[--findings <json-or-@file>] [--quiet]\n' +
  '   or: cli-relay loop record <thread> --plan <path> --repo <path> --reviewer <backend> ' +
  '--verdict-file <path> [--model <model>] [--files <path,path>] [--quiet]';
const CHECK_USAGE = 'usage: cli-relay loop check <thread> [--plan <path>] [--repo <path>] [--quiet]';
const VERDICT_FILE_FLAGS = ['verdict', 'summary', 'findings', 'coverage', 'limitations'];

function isQuiet(flags) {
  return flags.quiet === true || flags.quiet === 'true';
}

function splitFiles(raw) {
  if (typeof raw !== 'string') return undefined;
  return raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const name = arg.slice(2);
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags[name] = true;
      } else {
        flags[name] = value;
        i += 1;
      }
    }
  }
  return flags;
}

function parseFindings(raw) {
  if (raw === undefined) return [];
  const text = raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw;
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('--findings must parse to a JSON array');
  return parsed;
}

export async function cmdLoopRecord(thread, rest) {
  if (!thread) {
    console.error(RECORD_USAGE);
    process.exitCode = 2;
    return;
  }
  const flags = parseFlags(rest);
  const quiet = isQuiet(flags);
  const verdictFilePath = typeof flags['verdict-file'] === 'string' ? flags['verdict-file'] : null;
  const conflicting = VERDICT_FILE_FLAGS.filter((name) => flags[name] !== undefined);
  if (verdictFilePath && conflicting.length > 0) {
    console.error(`${RECORD_USAGE}\n--verdict-file cannot be combined with: ${conflicting.join(', ')}`);
    process.exitCode = 2;
    return;
  }

  const required = ['plan', 'repo', 'reviewer'];
  if (!verdictFilePath) required.push('verdict', 'summary');
  const missing = required
    .filter((name) => typeof flags[name] !== 'string' || flags[name].length === 0);
  if (missing.length > 0) {
    console.error(`${RECORD_USAGE}\nmissing/invalid: ${missing.join(', ')}`);
    process.exitCode = 2;
    return;
  }

  let verdict;
  if (verdictFilePath) {
    let text;
    try {
      text = readFileSync(verdictFilePath, 'utf8');
    } catch (error) {
      console.error(
        `cli-relay loop record: cannot read --verdict-file ${verdictFilePath}: ${error.message}`,
      );
      process.exitCode = 2;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.error(`cli-relay loop record: --verdict-file is not valid JSON: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    const errors = validateVerdict(parsed);
    if (errors.length > 0) {
      console.error(`cli-relay loop record: invalid verdict: ${errors.join('; ')}`);
      process.exitCode = 1;
      return;
    }
    verdict = parsed;
  } else {
    let findings;
    try {
      findings = parseFindings(flags.findings);
    } catch (error) {
      console.error(`cli-relay loop record: --findings ${error.message}`);
      process.exitCode = 2;
      return;
    }
    verdict = {
      verdict: flags.verdict,
      summary: flags.summary,
      findings,
      ...(flags.coverage !== undefined ? { coverage: flags.coverage } : {}),
      ...(flags.limitations !== undefined ? { limitations: flags.limitations } : {}),
    };
  }

  let record;
  try {
    record = await recordApproval({
      thread,
      planPath: flags.plan,
      repoPath: flags.repo,
      reviewer: flags.reviewer,
      model: typeof flags.model === 'string' ? flags.model : null,
      files: splitFiles(flags.files),
      verdict,
    });
  } catch (error) {
    console.error(`cli-relay loop record: ${error.message}`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    return;
  }

  if (quiet) {
    console.log(`recorded ${verdict.verdict} for ${thread}`);
    return;
  }
  const { manifest, ...summary } = record;
  console.log(JSON.stringify(summary, null, 2));
}

export function cmdLoopCheck(thread, rest) {
  if (!thread) {
    console.error(CHECK_USAGE);
    process.exitCode = 2;
    return;
  }
  const flags = parseFlags(rest);
  const quiet = isQuiet(flags);
  const result = checkApproval({
    thread,
    planPath: typeof flags.plan === 'string' ? flags.plan : undefined,
    repoPath: typeof flags.repo === 'string' ? flags.repo : undefined,
  });
  if (quiet) {
    console.log(result.allowed ? 'approved' : `denied: ${result.reason}`);
    process.exitCode = result.allowed ? 0 : 1;
    return;
  }
  const { record, ...rest2 } = result;
  const output = record ? { ...rest2, record: { ...record, manifest: undefined } } : rest2;
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = result.allowed ? 0 : 1;
}
