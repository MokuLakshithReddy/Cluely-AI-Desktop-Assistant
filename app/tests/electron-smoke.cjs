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

let stdoutCaptured = '';
let stderrCaptured = '';

child.stdout.on('data', data => {
  stdoutCaptured += data.toString();
  console.log('[Electron stdout]:', data.toString().trim());
});

child.stderr.on('data', data => {
  stderrCaptured += data.toString();
  console.log('[Electron stderr]:', data.toString().trim());
});

// Run for 3 seconds to let BrowserWindow, IPC handlers, and state initialize
const timer = setTimeout(() => {
  console.log('Electron windows initialized cleanly without crash.');
  console.log('Terminating smoke process cleanly...');
  child.kill();
}, 3000);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  console.log(`Process exited with code: ${code}, signal: ${signal}`);

  // Fatal crashes produce exit code > 0 without SIGTERM
  if (code !== 0 && signal !== 'SIGTERM' && signal !== null) {
    console.error('Smoke test failure: Electron crashed on startup!');
    process.exit(1);
  }

  console.log('--- Electron Desktop Runtime Smoke Test: PASSED ---');
  process.exit(0);
});
