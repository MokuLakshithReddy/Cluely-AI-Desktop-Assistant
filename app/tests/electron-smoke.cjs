const { spawn } = require('child_process');
const path = require('path');

const electronBinary = require('electron');
const appPath = path.resolve(__dirname, '..');

console.log('--- Initiating Electron Desktop Runtime Smoke Test ---');
console.log('Electron binary:', electronBinary);
console.log('App root:', appPath);

// Ensure clean environment without ELECTRON_RUN_AS_NODE so Electron runs as a desktop app
const cleanEnv = { ...process.env, CI: 'true', ELECTRON_ENABLE_LOGGING: '1' };
delete cleanEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, [appPath], {
  env: cleanEnv,
  stdio: 'pipe',
});

let appReadyObserved = false;
let cleanTerminationRequested = false;
let stdoutCaptured = '';
let stderrCaptured = '';

child.on('error', err => {
  console.error('Smoke test error: Failed to spawn Electron child process:', err);
  process.exit(1);
});

child.stdout.on('data', data => {
  const str = data.toString();
  stdoutCaptured += str;
  console.log('[Electron stdout]:', str.trim());

  if (str.includes('[APP_READY]') && !appReadyObserved) {
    appReadyObserved = true;
    console.log('✓ Verified application-ready event observed from Electron runtime.');
    cleanTerminationRequested = true;

    // Gracefully terminate after readiness confirmation
    setTimeout(() => {
      console.log('Sending SIGTERM for clean shutdown verification...');
      try {
        child.kill('SIGTERM');
      } catch (e) {
        console.error('Error sending SIGTERM:', e);
      }
    }, 500);
  }
});

child.stderr.on('data', data => {
  const str = data.toString();
  stderrCaptured += str;
  console.log('[Electron stderr]:', str.trim());
});

// Maximum timeout of 15 seconds waiting for explicit readiness signal
const timeoutHandle = setTimeout(() => {
  console.error('Smoke test failure: Timed out waiting for [APP_READY] signal after 15 seconds.');
  try {
    child.kill('SIGKILL');
  } catch {}
  process.exit(1);
}, 15000);

child.on('exit', (code, signal) => {
  clearTimeout(timeoutHandle);
  console.log(`Process exited with code: ${code}, signal: ${signal}`);

  // Must have observed explicit application readiness signal
  if (!appReadyObserved) {
    console.error('Smoke test failure: Process exited unexpectedly before [APP_READY] signal was emitted!');
    process.exit(1);
  }

  // Must have been terminated as part of the verified test flow
  if (!cleanTerminationRequested) {
    console.error('Smoke test failure: Process crashed or exited unexpectedly after ready signal without clean termination!');
    process.exit(1);
  }

  console.log('--- Electron Desktop Runtime Smoke Test: PASSED ---');
  process.exit(0);
});
