const { spawn } = require('child_process');
const electronBinary = require('electron');
const path = require('path');

const appPath = path.resolve(__dirname, '..');
const cleanEnv = { ...process.env };
delete cleanEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, [appPath], {
  cwd: appPath,
  env: cleanEnv,
  stdio: 'inherit',
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
