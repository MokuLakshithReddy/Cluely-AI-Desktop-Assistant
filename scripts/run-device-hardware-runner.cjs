// scripts/run-device-hardware-runner.cjs
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const electronBinary = path.resolve(__dirname, '..', 'app', 'node_modules', 'electron', 'dist', 'electron.exe');
const targetScript = path.resolve(__dirname, 'run-hardware-device-tests.cjs');

console.log('--- Launching Hardware Device Diagnostic Suite ---');
console.log('Electron binary:', electronBinary);
console.log('Target script:', targetScript);

const cleanEnv = {
  ...process.env,
  ELECTRON_ENABLE_LOGGING: '1',
};
delete cleanEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, [targetScript], {
  cwd: path.resolve(__dirname, '..'),
  env: cleanEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.stdout.on('data', data => {
  process.stdout.write(data.toString());
});

child.stderr.on('data', data => {
  process.stderr.write(data.toString());
});

child.on('close', code => {
  console.log(`Diagnostic process completed with exit code: ${code}`);
  process.exit(code);
});
