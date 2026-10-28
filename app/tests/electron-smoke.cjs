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
let terminationSignalDelivered = false;
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

    // Wait a brief stabilization tick before delivering SIGTERM
    setTimeout(() => {
      // Set flag immediately prior to kill invocation
      terminationSignalDelivered = true;
      console.log('Delivering SIGTERM to initiate clean shutdown verification...');
      try {
        child.kill('SIGTERM');
      } catch (e) {
        console.error('Error delivering SIGTERM to child process:', e);
        process.exit(1);
      }
    }, 400);
  }
});

child.stderr.on('data', data => {
  const str = data.toString();
  stderrCaptured += str;
  console.log('[Electron stderr]:', str.trim());
});

// Hard timeout of 15 seconds waiting for readiness
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

  // 1. Fail if exited before [APP_READY] was observed
  if (!appReadyObserved) {
    console.error(`Smoke test failure: Process exited unexpectedly before [APP_READY] signal was emitted (code: ${code}, signal: ${signal})!`);
    process.exit(1);
  }

  // 2. Fail if exited after [APP_READY] but before SIGTERM was deliberately delivered (i.e. crashed in the interval!)
  if (!terminationSignalDelivered) {
    console.error(`Smoke test failure: Process crashed unexpectedly after [APP_READY] before SIGTERM was delivered (code: ${code}, signal: ${signal})!`);
    process.exit(1);
  }

  // 3. Fail if stderr contains fatal exceptions
  if (stderrCaptured.includes('Uncaught Exception') || stderrCaptured.includes('Fatal error') || stderrCaptured.includes('Segmentation fault')) {
    console.error('Smoke test failure: Uncaught exceptions or fatal errors detected in process output!');
    process.exit(1);
  }

  console.log('--- Electron Desktop Runtime Smoke Test: PASSED ---');
  process.exit(0);
});
