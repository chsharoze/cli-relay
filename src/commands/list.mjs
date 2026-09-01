import { MAP_PATH } from '../config.mjs';
import { loadMap } from '../core/map-store.mjs';

function truncId(id, max = 24) {
  if (id == null) return '-';
  const value = String(id);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function cmdList() {
  const map = loadMap();
  const names = Object.keys(map.sessions);
  if (names.length === 0) {
    console.log(`no threads recorded in ${MAP_PATH}`);
    return;
  }
  const columns = [
    'thread', 'backend', 'confirmed', 'native_session_id', 'status', 'turns', 'created_iso',
    'last_run_iso', 'last_exit_code', 'resume_fails', 'compacted', 'pins',
  ];
  const rows = names.sort().map((name) => {
    const session = map.sessions[name];
    return {
      thread: name,
      backend: session.backend ?? '?',
      confirmed: session.confirmed ? 'yes' : 'no',
      native_session_id: truncId(session.native_session_id),
      status: session.status ?? '-',
      turns: session.turn_count ?? '-',
      created_iso: session.created_iso ?? '-',
      last_run_iso: session.last_run_iso ?? 'never',
      last_exit_code: session.last_exit_code ?? '-',
      resume_fails: session.consecutive_resume_failures ?? 0,
      compacted: session.compaction_detected === true
        ? 'YES'
        : session.compaction_detected === false ? 'no' : '-',
      pins: session.pinned_facts?.length ?? 0,
    };
  });
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(column.length, ...rows.map((row) => String(row[column]).length)),
    ]),
  );
  const formatRow = (values) => columns
    .map((column) => String(values[column]).padEnd(widths[column]))
    .join('  ');
  console.log(formatRow(Object.fromEntries(columns.map((column) => [column, column]))));
  console.log(columns.map((column) => '-'.repeat(widths[column])).join('  '));
  for (const row of rows) console.log(formatRow(row));
}
