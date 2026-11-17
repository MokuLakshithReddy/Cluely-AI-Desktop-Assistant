#!/usr/bin/env node
'use strict';

/**
 * Scandium Portable Python Runtime Provisioning Script
 * Provisions an isolated, complete Python runtime with RealtimeSTT & faster-whisper
 * dependencies into app/resources/python for Windows, macOS, and Linux distributables.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const targetPythonDir = path.join(repoRoot, 'app', 'resources', 'python');
const requirementsPath = path.join(repoRoot, 'app', 'python-stt', 'requirements.txt');
const isWin = process.platform === 'win32';

console.log('[ProvisionPython] Starting Python runtime provisioning for', process.platform);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDir(targetPythonDir);

function getVenvPythonPath(dir) {
  if (isWin) {
    const scriptsExe = path.join(dir, 'Scripts', 'python.exe');
    if (fs.existsSync(scriptsExe)) return scriptsExe;
    const rootExe = path.join(dir, 'python.exe');
    if (fs.existsSync(rootExe)) return rootExe;
    return scriptsExe;
  } else {
    const binPy3 = path.join(dir, 'bin', 'python3');
    if (fs.existsSync(binPy3)) return binPy3;
    const binPy = path.join(dir, 'bin', 'python');
    if (fs.existsSync(binPy)) return binPy;
    return binPy3;
  }
}

// 1. Check if a local .venv with installed packages is available to clone quickly
const localVenv = path.join(repoRoot, '.venv');
const localVenvPython = getVenvPythonPath(localVenv);
const targetPython = getVenvPythonPath(targetPythonDir);

let provisioned = false;

if (fs.existsSync(localVenv) && fs.existsSync(localVenvPython) && !fs.existsSync(targetPython)) {
  console.log('[ProvisionPython] Copying existing local .venv to app/resources/python...');
  try {
    fs.cpSync(localVenv, targetPythonDir, {
      recursive: true,
      force: true,
      filter: (source) => {
        // Exclude transient caches and git files to reduce package size
        return !source.includes('__pycache__') && !source.includes('.git');
      }
    });

    // On Windows, ensure python.exe also exists at root of python/
    if (isWin) {
      const scriptsPy = path.join(targetPythonDir, 'Scripts', 'python.exe');
      const rootPy = path.join(targetPythonDir, 'python.exe');
      if (fs.existsSync(scriptsPy) && !fs.existsSync(rootPy)) {
        try { fs.copyFileSync(scriptsPy, rootPy); } catch {}
      }
    }
    provisioned = true;
    console.log('[ProvisionPython] Successfully cloned local .venv into app/resources/python.');
  } catch (err) {
    console.warn('[ProvisionPython] Failed to clone .venv, will build fresh venv:', err.message);
  }
}

// 2. If not cloned, create a clean standalone virtual environment
if (!provisioned && !fs.existsSync(targetPython)) {
  console.log('[ProvisionPython] Creating fresh standalone virtualenv in app/resources/python...');
  let basePython = 'python';
  if (process.env.PYTHON && fs.existsSync(process.env.PYTHON)) {
    basePython = process.env.PYTHON;
  } else if (!isWin) {
    basePython = 'python3';
  }

  try {
    execSync(`"${basePython}" -m venv "${targetPythonDir}"`, {
      stdio: 'inherit',
      cwd: repoRoot,
    });
  } catch (err) {
    console.error('[ProvisionPython] Failed to create virtualenv:', err.message);
    process.exit(1);
  }

  const venvPython = getVenvPythonPath(targetPythonDir);
  console.log('[ProvisionPython] Installing requirements into', venvPython);

  try {
    execSync(`"${venvPython}" -m pip install --upgrade pip`, {
      stdio: 'inherit',
      cwd: repoRoot,
    });
    execSync(`"${venvPython}" -m pip install -r "${requirementsPath}"`, {
      stdio: 'inherit',
      cwd: repoRoot,
    });
    // On Windows, copy python.exe to root if only in Scripts
    if (isWin) {
      const scriptsPy = path.join(targetPythonDir, 'Scripts', 'python.exe');
      const rootPy = path.join(targetPythonDir, 'python.exe');
      if (fs.existsSync(scriptsPy) && !fs.existsSync(rootPy)) {
        try { fs.copyFileSync(scriptsPy, rootPy); } catch {}
      }
    }
    provisioned = true;
  } catch (err) {
    console.error('[ProvisionPython] Failed to install requirements:', err.message);
    process.exit(1);
  }
}

// 3. Verify the provisioned python runtime
const finalPython = getVenvPythonPath(targetPythonDir);
if (!fs.existsSync(finalPython)) {
  console.error('[ProvisionPython] Verification failed: Python executable not found at', finalPython);
  process.exit(1);
}

try {
  const check = spawnSync(finalPython, ['-c', 'import RealtimeSTT; import faster_whisper; print("REALTIME_STT_OK")'], {
    encoding: 'utf8',
  });
  if (check.status === 0 && check.stdout.includes('REALTIME_STT_OK')) {
    console.log('[ProvisionPython] Verified: RealtimeSTT and faster_whisper load successfully.');
  } else {
    console.warn('[ProvisionPython] Runtime check warning:', check.stderr || check.stdout);
  }
} catch (e) {
  console.warn('[ProvisionPython] Runtime check caught exception:', e.message);
}

// Write metadata marker
const metadata = {
  platform: process.platform,
  arch: process.arch,
  provisionedAt: new Date().toISOString(),
  executable: finalPython,
};
fs.writeFileSync(path.join(targetPythonDir, 'PROVISIONED.json'), JSON.stringify(metadata, null, 2));

console.log('[ProvisionPython] Python runtime provisioning completed successfully at:', targetPythonDir);
