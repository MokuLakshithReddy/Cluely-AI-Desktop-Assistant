#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const executable = process.argv[2] || process.env.PACKAGED_APP_EXECUTABLE;
if (!executable) {
  console.error('Usage: node app/tests/packaged-smoke.cjs <packaged-executable>');
  process.exit(2);
}
const absoluteExecutable = path.resolve(executable);
if (!fs.existsSync(absoluteExecutable)) {
  console.error('Packaged executable does not exist:', absoluteExecutable);
  process.exit(2);
}

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-packaged-smoke-'));
const userData = path.join(smokeRoot, 'user-data');
fs.mkdirSync(userData, { recursive: true });
const shutdownTrigger = path.join(smokeRoot, 'packaged-smoke-shutdown.trigger');
const env = {
  ...process.env,
  CI: 'true',
  SMOKE_TEST: 'true',
  SMOKE_TEST_MODE: 'packaged',
  SMOKE_TEST_USER_DATA: userData,
  SMOKE_TEST_SHUTDOWN_TRIGGER: shutdownTrigger,
  ELECTRON_ENABLE_LOGGING: '1',
};

if (process.platform === 'win32') {
  env.APPDATA = path.join(smokeRoot, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(smokeRoot, 'AppData', 'Local');
} else {
  env.HOME = path.join(smokeRoot, 'home');
  env.XDG_CONFIG_HOME = path.join(env.HOME, '.config');
  env.XDG_CACHE_HOME = path.join(env.HOME, '.cache');
}
for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}
delete env.ELECTRON_RUN_AS_NODE;

const args = [];
if (process.platform === 'linux' && /\.AppImage$/i.test(absoluteExecutable)) {
  args.push('--appimage-extract-and-run');
}
if (process.platform === 'linux') {
  // This smoke process runs from an extracted AppImage in a runner-owned temp
  // directory, so its chrome-sandbox helper cannot keep root:4755 ownership.
  // The no-sandbox flag is test-only; packaged production BrowserWindows still
  // retain sandbox:true in their webPreferences.
  args.push('--no-sandbox');
}

const isLinuxHeadless = process.platform === 'linux' && !process.env.DISPLAY;
let command = absoluteExecutable;
let commandArgs = args;
if (isLinuxHeadless) {
  command = 'xvfb-run';
  commandArgs = ['-a', absoluteExecutable, ...args];
}

console.log('--- Packaged application launch smoke ---');
console.log('Executable:', absoluteExecutable);
console.log('Temporary profile:', userData);

const child = spawn(command, commandArgs, {
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let appReady = false;
let packagedReady = false;
let packagedFailed = false;
let shutdownDelivered = false;
let shutdownTimeout = null;
let output = '';
let errorOutput = '';
let finished = false;

function requestShutdown() {
  if (shutdownDelivered || finished) return;
  shutdownDelivered = true;
  try {
    fs.writeFileSync(shutdownTrigger, 'QUIT', { encoding: 'utf8', flag: 'w' });
  } catch (error) {
    console.error('Failed to write packaged shutdown trigger:', error);
    try { child.kill(); } catch {}
    return;
  }
  shutdownTimeout = setTimeout(() => {
    console.error('Packaged app did not shut down within 15 seconds.');
    try { child.kill(); } catch {}
  }, 15000);
}

child.on('error', error => {
  console.error('Failed to start packaged application:', error);
  packagedFailed = true;
});

child.stdout.on('data', data => {
  const text = data.toString();
  output += text;
  process.stdout.write(text);
  if (text.includes('[APP_READY]')) appReady = true;
  if (text.includes('[PACKAGED_SMOKE_READY]')) {
    packagedReady = true;
    requestShutdown();
  }
  if (text.includes('[PACKAGED_SMOKE_FAILED]')) {
    packagedFailed = true;
    requestShutdown();
  }
});

child.stderr.on('data', data => {
  const text = data.toString();
  errorOutput += text;
  process.stderr.write(text);
});

const readinessTimeout = setTimeout(() => {
  console.error('Timed out waiting for packaged renderer/preload/IPC readiness after 60 seconds.');
  packagedFailed = true;
  try { child.kill(); } catch {}
}, 60000);

child.on('close', (code, signal) => {
  finished = true;
  clearTimeout(readinessTimeout);
  if (shutdownTimeout) clearTimeout(shutdownTimeout);

  try {
    assert.equal(appReady, true, 'Packaged app must reach the Electron app-ready event');
    assert.equal(packagedReady, true, 'Packaged control/chat windows must load renderer, preload, and IPC');
    assert.equal(packagedFailed, false, 'Packaged smoke must not report an error');
    assert.equal(shutdownDelivered, true, 'Smoke harness must request a controlled shutdown');
    assert.match(output, /\[APP_CLEAN_SHUTDOWN\]/, 'Packaged app must acknowledge the shutdown trigger');
    assert.match(output, /\[APP_BEFORE_QUIT\]/, 'Packaged app must run before-quit hooks');
    assert.match(output, /\[APP_WILL_QUIT\]/, 'Packaged app must run will-quit hooks');
    assert.ok(!/Uncaught Exception|Fatal error|Segmentation fault/i.test(errorOutput), 'No fatal exception may appear on stderr');
    assert.equal(signal, null, 'Packaged app must not be force-killed');
    assert.equal(code, 0, 'Packaged app must exit normally with code zero');
    console.log('--- Packaged application launch smoke: PASSED ---');
  } catch (error) {
    console.error('--- Packaged application launch smoke: FAILED ---');
    console.error(error);
    console.error('Exit code:', code, 'signal:', signal);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
  }
});

child.on('error', () => {
  // The close/error paths share a single cleanup point; close is still emitted
  // by Node after an unsuccessful spawn attempt.
});
