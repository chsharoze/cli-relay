import { readFileSync } from 'node:fs';
import { checkApproval, recordApproval, VERDICTS } from '../governance/approval.mjs';

const RECORD_USAGE =
  'usage: cli-relay loop record <thread> --plan <path> --repo <path> --reviewer <backend> ' +
  `--verdict <${VERDICTS.join('|')}> --summary "<text>" [--model <model>] ` +
  '[--coverage "<text>"] [--limitations "<text>"] [--findings <json-or-@file>]';
const CHECK_USAGE = 'usage: cli-relay loop check <thread> [--plan <path>] [--repo <path>]';

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
  const missing = ['plan', 'repo', 'reviewer', 'verdict', 'summary']
    .filter((name) => typeof flags[name] !== 'string' || flags[name].length === 0);
  if (missing.length > 0) {
    console.error(`${RECORD_USAGE}\nmissing/invalid: ${missing.join(', ')}`);
    process.exitCode = 2;
    return;
  }

  let findings;
  try {
    findings = parseFindings(flags.findings);
  } catch (error) {
    console.error(`cli-relay loop record: --findings ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const verdict = {
    verdict: flags.verdict,
    summary: flags.summary,
    findings,
    ...(flags.coverage !== undefined ? { coverage: flags.coverage } : {}),
    ...(flags.limitations !== undefined ? { limitations: flags.limitations } : {}),
  };

  let record;
  try {
    record = await recordApproval({
      thread,
      planPath: flags.plan,
      repoPath: flags.repo,
      reviewer: flags.reviewer,
      model: typeof flags.model === 'string' ? flags.model : null,
      verdict,
    });
  } catch (error) {
    console.error(`cli-relay loop record: ${error.message}`);
    process.exitCode = 1;
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
  const result = checkApproval({
    thread,
    planPath: typeof flags.plan === 'string' ? flags.plan : undefined,
    repoPath: typeof flags.repo === 'string' ? flags.repo : undefined,
  });
  const { record, ...rest2 } = result;
  const output = record ? { ...rest2, record: { ...record, manifest: undefined } } : rest2;
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = result.allowed ? 0 : 1;
}
