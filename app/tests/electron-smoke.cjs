const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const electronBinary = require('electron');
const appPath = path.resolve(__dirname, '..');

console.log('--- Initiating Electron Desktop Runtime Smoke Test ---');
console.log('Electron binary:', electronBinary);
console.log('App root:', appPath);

// Keep all test writes inside a disposable Electron profile.
const smokeUserDataRoot = path.join(os.tmpdir(), 'cluely-electron-smoke-' + process.pid);
fs.mkdirSync(smokeUserDataRoot, { recursive: true });

// Ensure clean environment without ELECTRON_RUN_AS_NODE so Electron runs as a desktop app.
const cleanEnv = {
  ...process.env,
  CI: 'true',
  SMOKE_TEST: 'true',
  ELECTRON_ENABLE_LOGGING: '1',
  APPDATA: smokeUserDataRoot,
  XDG_CONFIG_HOME: smokeUserDataRoot,
  HOME: smokeUserDataRoot,
};
delete cleanEnv.ELECTRON_RUN_AS_NODE;

const triggerPath = path.join(appPath, '.smoke-shutdown.trigger');
if (fs.existsSync(triggerPath)) {
  try { fs.unlinkSync(triggerPath); } catch {}
}

// Detect if running on Linux in a headless environment without DISPLAY
const isLinuxHeadless = process.platform === 'linux' && !process.env.DISPLAY;
const spawnCmd = isLinuxHeadless ? 'xvfb-run' : electronBinary;
const spawnArgs = isLinuxHeadless ? ['-a', electronBinary, appPath] : [appPath];

const child = spawn(spawnCmd, spawnArgs, {
  cwd: appPath,
  env: cleanEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let appReadyObserved = false;
let e2eCompleted = false;
let e2eFailed = false;
let shutdownCommandDelivered = false;
let shutdownTimeoutHandle = null;
let stdoutCaptured = '';
let stderrCaptured = '';

child.on('error', err => {
  console.error('Smoke test error: Failed to spawn Electron child process:', err);
  process.exit(1);
});

function requestGracefulShutdown() {
  if (shutdownCommandDelivered) return;
  shutdownCommandDelivered = true;
  console.log('Delivering graceful shutdown trigger after desktop E2E result...');
  const shutdownPath = path.join(appPath, '.smoke-shutdown.trigger');
  try {
    fs.writeFileSync(shutdownPath, 'QUIT', 'utf8');
  } catch (e) {
    console.error('Error writing shutdown trigger file:', e);
    process.exit(1);
  }

  // Hard timeout for graceful shutdown: must complete lifecycle within 10 seconds of trigger.
  shutdownTimeoutHandle = setTimeout(() => {
    console.error('Smoke test failure: Electron failed to exit cleanly within 10 seconds after shutdown trigger!');
    try { child.kill('SIGKILL'); } catch {}
    process.exit(1);
  }, 10000);
}

child.stdout.on('data', data => {
  const str = data.toString();
  stdoutCaptured += str;
  console.log('[Electron stdout]:', str.trim());

  if (str.includes('[APP_READY]') && !appReadyObserved) {
    appReadyObserved = true;
    console.log('✓ Verified Electron application-ready event.');
  }

  if (str.includes('[E2E_COMPLETE]')) {
    e2eCompleted = true;
    requestGracefulShutdown();
  }

  if (str.includes('[E2E_FAILED]')) {
    e2eCompleted = true;
    e2eFailed = true;
    requestGracefulShutdown();
  }

});

child.stderr.on('data', data => {
  const str = data.toString();
  stderrCaptured += str;
  console.log('[Electron stderr]:', str.trim());
});

// Allow the real renderer/UI/IPC flow to finish before forcing shutdown.
const readinessTimeoutHandle = setTimeout(() => {
  console.error('Smoke test failure: Timed out waiting for desktop E2E completion after 45 seconds.');
  try {
    child.kill('SIGKILL');
  } catch {}
  process.exit(1);
}, 45000);

child.on('exit', (code, signal) => {
  clearTimeout(readinessTimeoutHandle);
  if (shutdownTimeoutHandle) clearTimeout(shutdownTimeoutHandle);

  console.log(`Process exited with code: ${code}, signal: ${signal}`);

  // 1. Verify that readiness was reached prior to exit
  if (!appReadyObserved) {
    console.error(`Smoke test failure: Process exited prematurely before [APP_READY] signal was emitted (code: ${code}, signal: ${signal})!`);
    process.exit(1);
  }

  // 2. Verify that the real desktop UI/preload/IPC workflow completed.
  if (!e2eCompleted || e2eFailed) {
    console.error('Smoke test failure: Desktop UI/IPC E2E did not complete successfully.');
    try { fs.rmSync(smokeUserDataRoot, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }

  // 3. Verify that shutdown command was delivered before exit.
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

  // 4. Require a genuine normal process exit. A forced signal is never a passing result,
  // even if the application emitted its graceful lifecycle markers beforehand.
  if (code !== 0 || signal !== null) {
    console.error(`Smoke test failure: Electron did not exit normally (signal: ${signal}, code: ${code}).`);
    process.exit(1);
  }

  // 6. Verify no fatal exceptions in stderr
  if (stderrCaptured.includes('Uncaught Exception') || stderrCaptured.includes('Fatal error') || stderrCaptured.includes('Segmentation fault')) {
    console.error('Smoke test failure: Fatal errors or uncaught exceptions detected in stderr output!');
    process.exit(1);
  }

  console.log('--- Electron Desktop UI/IPC E2E Smoke Test: PASSED (Dashboard, preload bridge, IPC, persistence, and clean shutdown) ---');
  try { fs.rmSync(smokeUserDataRoot, { recursive: true, force: true }); } catch {}
  process.exit(0);
});
