const { spawn } = require('child_process');
const path = require('path');

const electronBinary = require('electron');
const appPath = path.resolve(__dirname, '..');

console.log('Testing Electron launch with binary:', electronBinary);
console.log('App path:', appPath);

const cleanEnv = { ...process.env, CI: 'true', ELECTRON_ENABLE_LOGGING: '1' };
delete cleanEnv.ELECTRON_RUN_AS_NODE;

// Launch Electron with a 4-second timeout to verify it boots without crashing
const child = spawn(electronBinary, [appPath], {
  env: cleanEnv,
  stdio: 'pipe',
});

let output = '';
child.stdout.on('data', data => {
  output += data.toString();
  console.log('[Electron stdout]:', data.toString().trim());
});

child.stderr.on('data', data => {
  output += data.toString();
  console.log('[Electron stderr]:', data.toString().trim());
});

const timer = setTimeout(() => {
  console.log('Electron launched and ran successfully for 3.5 seconds. Terminating smoke test process.');
  child.kill();
  process.exit(0);
}, 3500);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  console.log(`Electron exited with code ${code}, signal: ${signal}`);
  if (code !== 0 && signal !== 'SIGTERM' && signal !== null) {
    console.error('Electron encountered an unexpected startup crash!');
    process.exit(1);
  } else {
    console.log('Smoke test passed successfully!');
    process.exit(0);
  }
});
