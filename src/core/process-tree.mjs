import { execFile } from 'node:child_process';

function warnFailure(action, error, stderr = '') {
  const detail = stderr.trim().slice(-2000);
  console.error(
    `warning: cli-relay ${action} failed (${error.code ?? 'unknown'}): ${error.message}` +
    (detail ? `\n${detail}` : ''),
  );
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    // An already-exited POSIX group is expected during cleanup. Permissions and
    // other real failures must not disappear behind the same empty catch.
    if (error.code !== 'ESRCH') warnFailure(`process group ${pgid} signal ${signal}`, error);
    return false;
  }
}

export function isProcessGroupAlive(pgid) {
  if (!pgid || process.platform === 'win32') return false;
  return signalGroup(pgid, 0);
}

// POSIX remains synchronous with the original negative-pgid signal arguments.
// Windows has no equivalent group signalling: one forceful, shell-free taskkill
// targets the positive root PID. Callers must await it before forcing their exit.
export function killProcessTree(pid, signal) {
  if (!pid) return;
  if (process.platform !== 'win32') {
    signalGroup(pid, signal);
    return;
  }
  return new Promise((resolve) => {
    try {
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        shell: false,
      }, (error, _stdout, stderr) => {
        if (error) warnFailure(`taskkill /PID ${pid}`, error, stderr);
        resolve();
      });
    } catch (error) {
      warnFailure(`taskkill /PID ${pid}`, error);
      resolve();
    }
  });
}
