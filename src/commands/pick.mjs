// INTERFACE ONLY — Jev (the model-recommendation path) is not implemented yet.
//
// Future design: collect the live candidates (reusing cmdModels's listing path), then ask
// command-code `-m typesafe/jev` for a recommendation over those candidates. Output would
// be advisory text only — never auto-applied to a dispatch.
export async function cmdPick(_adapters, taskDescription) {
  if (typeof taskDescription !== 'string' || taskDescription.trim() === '') {
    console.error("usage: cli-relay pick '<task description>'");
    process.exitCode = 2;
    return;
  }
  console.error('pick is not yet implemented (advisory model recommendation deferred)');
  process.exitCode = 1;
}
