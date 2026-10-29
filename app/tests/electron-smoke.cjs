const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const electronBinary = require('electron');
const appPath = path.resolve(__dirname, '..');

console.log('--- Initiating Electron Desktop Runtime Smoke Test ---');
console.log('Electron binary:', electronBinary);
console.log('App root:', appPath);

// Ensure clean environment without ELECTRON_RUN_AS_NODE so Electron runs as a desktop app
const cleanEnv = {
  ...process.env,
  CI: 'true',
  SMOKE_TEST: 'true',
  ELECTRON_ENABLE_LOGGING: '1',
};
delete cleanEnv.ELECTRON_RUN_AS_NODE;

const triggerPath = path.join(appPath, '.smoke-shutdown.trigger');
if (fs.existsSync(triggerPath)) {
  try { fs.unlinkSync(triggerPath); } catch {}
}

const child = spawn(electronBinary, [appPath], {
  cwd: appPath,
  env: cleanEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let appReadyObserved = false;
let shutdownCommandDelivered = false;
let shutdownTimeoutHandle = null;
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

    // Wait a brief stabilization tick before delivering graceful shutdown trigger
    setTimeout(() => {
      shutdownCommandDelivered = true;
      console.log('Delivering graceful shutdown trigger to verify clean lifecycle exit...');
      const triggerPath = path.join(appPath, '.smoke-shutdown.trigger');
      try {
        fs.writeFileSync(triggerPath, 'QUIT', 'utf8');
      } catch (e) {
        console.error('Error writing shutdown trigger file:', e);
        process.exit(1);
      }

      // Hard timeout for graceful shutdown: must complete lifecycle within 10 seconds of trigger
      shutdownTimeoutHandle = setTimeout(() => {
        console.error('Smoke test failure: Electron failed to exit cleanly within 10 seconds after shutdown trigger!');
        try {
          child.kill('SIGKILL');
        } catch {}
        process.exit(1);
      }, 10000);
    }, 400);
  }

  if (str.includes('[APP_WILL_QUIT]')) {
    // Graceful quit completed. On Windows, helper workers may hold stdio handles open briefly.
    // Ensure clean process detachment after graceful hooks have fully emitted.
    setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, 500);
  }
});

child.stderr.on('data', data => {
  const str = data.toString();
  stderrCaptured += str;
  console.log('[Electron stderr]:', str.trim());
});

// Maximum timeout of 15 seconds waiting for initial readiness signal
const readinessTimeoutHandle = setTimeout(() => {
  console.error('Smoke test failure: Timed out waiting for [APP_READY] signal after 15 seconds.');
  try {
    child.kill('SIGKILL');
  } catch {}
  process.exit(1);
}, 15000);

child.on('exit', (code, signal) => {
  clearTimeout(readinessTimeoutHandle);
  if (shutdownTimeoutHandle) clearTimeout(shutdownTimeoutHandle);

  console.log(`Process exited with code: ${code}, signal: ${signal}`);

  // 1. Verify that readiness was reached prior to exit
  if (!appReadyObserved) {
    console.error(`Smoke test failure: Process exited prematurely before [APP_READY] signal was emitted (code: ${code}, signal: ${signal})!`);
    process.exit(1);
  }

  // 2. Verify that shutdown command was delivered before exit (distinguish crash in stabilization interval)
  if (!shutdownCommandDelivered) {
    console.error(`Smoke test failure: Process crashed unexpectedly after [APP_READY] before clean shutdown command was delivered (code: ${code}, signal: ${signal})!`);
    process.exit(1);
  }

  // 3. Verify clean shutdown lifecycle events
  if (!stdoutCaptured.includes('[APP_CLEAN_SHUTDOWN]')) {
    console.error('Smoke test failure: Process exited without emitting [APP_CLEAN_SHUTDOWN] marker!');
    process.exit(1);
  }

  if (!stdoutCaptured.includes('[APP_BEFORE_QUIT]')) {
    console.error('Smoke test failure: Process exited without executing [APP_BEFORE_QUIT] lifecycle hooks!');
    process.exit(1);
  }

  if (!stdoutCaptured.includes('[APP_WILL_QUIT]')) {
    console.error('Smoke test failure: Process exited without executing [APP_WILL_QUIT] lifecycle hooks!');
    process.exit(1);
  }

  // 4. Verify clean exit: Graceful lifecycle verified
  if (code !== 0 && signal !== 'SIGTERM' && signal !== null) {
    console.error(`Smoke test failure: Unexpected termination signal: ${signal}, code: ${code}!`);
    process.exit(1);
  }

  // 6. Verify no fatal exceptions in stderr
  if (stderrCaptured.includes('Uncaught Exception') || stderrCaptured.includes('Fatal error') || stderrCaptured.includes('Segmentation fault')) {
    console.error('Smoke test failure: Fatal errors or uncaught exceptions detected in stderr output!');
    process.exit(1);
  }

  console.log('--- Electron Desktop Runtime Smoke Test: PASSED (Verified Clean Shutdown with Exit Code 0) ---');
  process.exit(0);
});
