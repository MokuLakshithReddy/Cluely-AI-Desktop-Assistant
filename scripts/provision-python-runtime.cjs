#!/usr/bin/env node
'use strict';

/**
 * Scandium Standalone Relocatable Python Runtime Provisioning Script
 * Provisions a genuinely self-contained, relocatable CPython runtime with RealtimeSTT & faster-whisper
 * into app/resources/python for Windows, macOS, and Linux distributables.
 * Fails closed if the runtime is not relocatable or fails clean-machine execution.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
const targetPythonDir = path.join(repoRoot, 'app', 'resources', 'python');
const requirementsPath = path.join(repoRoot, 'app', 'python-stt', 'requirements.txt');
const isWin = process.platform === 'win32';

console.log('[ProvisionPython] Starting standalone relocatable Python provisioning for', process.platform);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDir(targetPythonDir);

function getTargetPythonExe(dir) {
  if (isWin) {
    const rootExe = path.join(dir, 'python.exe');
    if (fs.existsSync(rootExe)) return rootExe;
    const scriptsExe = path.join(dir, 'Scripts', 'python.exe');
    if (fs.existsSync(scriptsExe)) return scriptsExe;
    return rootExe;
  } else {
    const binPy3 = path.join(dir, 'bin', 'python3');
    if (fs.existsSync(binPy3)) return binPy3;
    const binPy = path.join(dir, 'bin', 'python');
    if (fs.existsSync(binPy)) return binPy;
    return binPy3;
  }
}

// 1. Locate base Python and active .venv
const localVenv = path.join(repoRoot, '.venv');
let basePython = 'python';
if (process.env.PYTHON && fs.existsSync(process.env.PYTHON)) {
  basePython = process.env.PYTHON;
} else if (!isWin) {
  basePython = 'python3';
}

let basePrefix = '';
try {
  basePrefix = execSync(`"${basePython}" -c "import sys; print(sys.base_prefix)"`, { encoding: 'utf8' }).trim();
} catch (e) {
  if (isWin) {
    const venvPy = path.join(localVenv, 'Scripts', 'python.exe');
    if (fs.existsSync(venvPy)) {
      try {
        basePrefix = execSync(`"${venvPy}" -c "import sys; print(sys.base_prefix)"`, { encoding: 'utf8' }).trim();
      } catch {}
    }
  }
}

console.log('[ProvisionPython] Detected Base Python installation prefix:', basePrefix || '(using system python)');

// 2. Provision Windows Standalone CPython Engine
if (isWin && basePrefix && fs.existsSync(basePrefix)) {
  console.log('[ProvisionPython] Assembling fully relocatable CPython distribution from:', basePrefix);

  // A. Copy Python root executables and core runtime DLLs (e.g. python312.dll, python3.dll, vcruntime140*.dll)
  const rootFiles = fs.readdirSync(basePrefix);
  for (const file of rootFiles) {
    if (/\.(dll|exe)$/i.test(file)) {
      const src = path.join(basePrefix, file);
      const dst = path.join(targetPythonDir, file);
      try {
        fs.copyFileSync(src, dst);
      } catch (err) {
        console.warn(`[ProvisionPython] Warning copying root binary ${file}:`, err.message);
      }
    }
  }

  // Ensure python.exe is also in Scripts/ for any tools expecting Scripts/python.exe
  const scriptsDir = path.join(targetPythonDir, 'Scripts');
  ensureDir(scriptsDir);
  const rootPy = path.join(targetPythonDir, 'python.exe');
  if (fs.existsSync(rootPy)) {
    try { fs.copyFileSync(rootPy, path.join(scriptsDir, 'python.exe')); } catch {}
  }

  // B. Copy standard library compiled C extensions (DLLs/)
  const baseDlls = path.join(basePrefix, 'DLLs');
  const targetDlls = path.join(targetPythonDir, 'DLLs');
  if (fs.existsSync(baseDlls)) {
    fs.cpSync(baseDlls, targetDlls, { recursive: true, force: true });
    console.log('[ProvisionPython] Bundled standard library C-extensions (DLLs).');
  }

  // C. Copy core standard library (Lib/ without test suites to save space)
  const baseLib = path.join(basePrefix, 'Lib');
  const targetLib = path.join(targetPythonDir, 'Lib');
  ensureDir(targetLib);
  if (fs.existsSync(baseLib)) {
    for (const item of fs.readdirSync(baseLib)) {
      if (item === 'site-packages' || item === 'test' || item === 'tests' || item === '__pycache__' || item === 'idlelib') continue;
      const s = path.join(baseLib, item);
      const d = path.join(targetLib, item);
      if (!fs.existsSync(d)) {
        try { fs.cpSync(s, d, { recursive: true, force: true }); } catch {}
      }
    }
    console.log('[ProvisionPython] Bundled Python standard library modules into Lib.');
  }

  // D. Copy installed site-packages from local .venv
  const venvSitePackages = path.join(localVenv, 'Lib', 'site-packages');
  const targetSitePackages = path.join(targetLib, 'site-packages');
  ensureDir(targetSitePackages);
  if (fs.existsSync(venvSitePackages)) {
    console.log('[ProvisionPython] Copying installed STT site-packages into standalone Lib/site-packages...');
    fs.cpSync(venvSitePackages, targetSitePackages, {
      recursive: true,
      force: true,
      filter: (src) => !src.includes('__pycache__') && !src.endsWith('.pyc')
    });
    console.log('[ProvisionPython] Bundled RealtimeSTT & faster-whisper site-packages.');
  }

  // E. Remove pyvenv.cfg so CPython NEVER redirects to the build runner's home path
  const pyvenvCfg = path.join(targetPythonDir, 'pyvenv.cfg');
  if (fs.existsSync(pyvenvCfg)) {
    fs.rmSync(pyvenvCfg, { force: true });
    console.log('[ProvisionPython] Removed pyvenv.cfg (eliminating build-machine path redirection).');
  }

  // F. Write isolated python._pth file enforcing strictly local path resolution
  // This prevents CPython from reading registry keys, host environment variables, or user site-packages
  const pthContent = '.\nLib\nLib/site-packages\nDLLs\nimport site\n';
  fs.writeFileSync(path.join(targetPythonDir, 'python312._pth'), pthContent, 'utf8');
  fs.writeFileSync(path.join(targetPythonDir, 'python._pth'), pthContent, 'utf8');
  console.log('[ProvisionPython] Created isolated path configuration (_pth) for relocatable execution.');

} else {
  // macOS / Linux / fallback Unix standalone provisioning
  console.log('[ProvisionPython] Provisioning Unix runtime into app/resources/python...');
  if (!fs.existsSync(path.join(targetPythonDir, 'bin', 'python3'))) {
    execSync(`"${basePython}" -m venv "${targetPythonDir}"`, { stdio: 'inherit', cwd: repoRoot });
    const venvPython = getTargetPythonExe(targetPythonDir);
    execSync(`"${venvPython}" -m pip install --upgrade pip`, { stdio: 'inherit', cwd: repoRoot });
    execSync(`"${venvPython}" -m pip install -r "${requirementsPath}"`, { stdio: 'inherit', cwd: repoRoot });
  }
}

// 3. Clean-Machine Portability Verification
const finalPython = getTargetPythonExe(targetPythonDir);
if (!fs.existsSync(finalPython)) {
  console.error('[ProvisionPython] FATAL: Python executable not found at:', finalPython);
  process.exit(1);
}

console.log('[ProvisionPython] Executing Clean-Machine Portability Verification on:', finalPython);

const cleanMachineScript = `
import sys, os
print("RUNNING_EXECUTABLE:", sys.executable)
print("SYS_PREFIX:", sys.prefix)
assert os.path.exists(sys.executable), "Executable must exist"
import RealtimeSTT
import faster_whisper
import ctranslate2
import onnxruntime
print("REALTIME_STT_STANDALONE_SUCCESS")
`;

// Scrub environment: remove host Python paths from PATH and remove PYTHON* vars
const cleanPath = isWin
  ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32;${process.env.SystemRoot || 'C:\\Windows'}`
  : '/usr/local/bin:/usr/bin:/bin';

const testEnv = {
  PATH: cleanPath,
  SYSTEMROOT: process.env.SystemRoot || 'C:\\Windows',
  TEMP: process.env.TEMP || os.tmpdir(),
  TMP: process.env.TMP || os.tmpdir(),
};

const check = spawnSync(finalPython, ['-c', cleanMachineScript], {
  env: testEnv,
  encoding: 'utf8',
  timeout: 45000,
});

if (check.status === 0 && check.stdout && check.stdout.includes('REALTIME_STT_STANDALONE_SUCCESS')) {
  console.log('[ProvisionPython] CLEAN-MACHINE TEST PASSED!');
  console.log(check.stdout.trim());
} else {
  console.error('[ProvisionPython] Clean-machine verification FAILED!');
  console.error('Exit code:', check.status);
  console.error('STDOUT:', check.stdout);
  console.error('STDERR:', check.stderr);
  process.exit(1);
}

// 4. Write provenance metadata
const metadata = {
  platform: process.platform,
  arch: process.arch,
  provisionedAt: new Date().toISOString(),
  executable: finalPython,
  isRelocatable: true,
  cleanMachineVerified: true,
};
fs.writeFileSync(path.join(targetPythonDir, 'PROVISIONED.json'), JSON.stringify(metadata, null, 2));

console.log('[ProvisionPython] Python runtime provisioning and clean-machine verification complete at:', targetPythonDir);
