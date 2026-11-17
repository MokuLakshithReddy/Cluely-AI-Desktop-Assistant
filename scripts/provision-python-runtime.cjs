#!/usr/bin/env node
'use strict';

/**
 * Provision a relocatable app-local CPython runtime for Scandium's RealtimeSTT
 * external-audio sidecar. The official standalone interpreter archive is
 * pinned by release tag and SHA-256, and all packages are installed into that
 * interpreter. No runner .venv or system Python installation is copied.
 *
 * Scandium provides system-loopback PCM and starts AudioToTextRecorder with
 * use_microphone=False. RealtimeSTT's PyAudio microphone worker is therefore
 * not needed; RealtimeSTT is installed with --no-deps to avoid PortAudio.
 */
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'app', 'resources', 'python');
const REQUIREMENTS = path.join(ROOT, 'app', 'python-stt', 'requirements.txt');
const PYTHON_VERSION = '3.12.16';
const BUILD_TAG = '20261110';

const ASSETS = {
  win32: {
    x64: {
      name: 'cpython-3.12.16+20261110-x86_64-pc-windows-msvc-install_only.tar.gz',
      sha256: 'e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b',
    },
  },
  darwin: {
    arm64: {
      name: 'cpython-3.12.16+20261110-aarch64-apple-darwin-install_only.tar.gz',
      sha256: 'e956e60bc9465d577ef8062059aa05cd3a2665b4b8678a2ed24e432368330b8f',
    },
    x64: {
      name: 'cpython-3.12.16+20261110-x86_64-apple-darwin-install_only.tar.gz',
      sha256: '83f2922437e6d546d0fcdb8c11f150a8e52787e8d9ea8651b1974e20908eb1bc',
    },
  },
  linux: {
    x64: {
      name: 'cpython-3.12.16+20261110-x86_64-unknown-linux-gnu-install_only.tar.gz',
      sha256: 'c2f87d4b4e8db3abddb0f116c6ccfc503d0cbdbb9ee8faacddad1b679ec12e99',
    },
    arm64: {
      name: 'cpython-3.12.16+20261110-aarch64-unknown-linux-gnu-install_only.tar.gz',
      sha256: '4792f81750282597fb2a3389fe18b945ed2ba6aad5e45ad406d122c58cb33081',
    },
  },
};

function run(command, args, options = {}) {
  console.log('[ProvisionPython] $ ' + command + ' ' + args.join(' '));
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    ...options,
  });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function getPythonExecutable(runtimeDir) {
  const candidates = process.platform === 'win32'
    ? [path.join(runtimeDir, 'python.exe')]
    : [
        path.join(runtimeDir, 'bin', 'python3'),
        path.join(runtimeDir, 'bin', 'python3.12'),
        path.join(runtimeDir, 'bin', 'python'),
      ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

function getCleanEnvironment() {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  const cleanPath = process.platform === 'win32'
    ? path.join(systemRoot, 'System32') + path.delimiter + systemRoot
    : '/usr/local/bin:/usr/bin:/bin';

  return {
    PATH: cleanPath,
    SYSTEMROOT: systemRoot,
    SystemRoot: systemRoot,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    TMPDIR: os.tmpdir(),
    HOME: os.tmpdir(),
  };
}

function provisionRuntime(asset) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scandium-python-runtime-'));
  const archivePath = path.join(workDir, asset.name);
  const extractDir = path.join(workDir, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });

  const assetUrl = 'https://github.com/astral-sh/python-build-standalone/releases/download/' +
    BUILD_TAG + '/' + encodeURIComponent(asset.name);

  try {
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    run(curl, [
      '--fail',
      '--location',
      '--silent',
      '--show-error',
      '--retry',
      '3',
      '--output',
      archivePath,
      assetUrl,
    ]);

    const actualHash = sha256File(archivePath);
    if (actualHash !== asset.sha256) {
      throw new Error(
        'Standalone CPython SHA-256 mismatch. Expected ' + asset.sha256 +
        ', received ' + actualHash
      );
    }
    console.log('[ProvisionPython] Verified CPython archive SHA-256: ' + actualHash);

    run('tar', ['-xzf', archivePath, '-C', extractDir]);
    const extractedPython = path.join(extractDir, 'python');
    if (!fs.existsSync(extractedPython)) {
      throw new Error('Expected install-only archive root "python/" was not found.');
    }

    fs.rmSync(TARGET, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    fs.cpSync(extractedPython, TARGET, {
      recursive: true,
      force: true,
      dereference: false,
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const python = getPythonExecutable(TARGET);
  if (!fs.existsSync(python)) {
    throw new Error('Standalone CPython executable not found: ' + python);
  }

  const cleanEnv = getCleanEnvironment();
  const pipVersion = spawnSync(python, ['-m', 'pip', '--version'], {
    cwd: os.tmpdir(),
    env: cleanEnv,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (pipVersion.status !== 0) {
    throw new Error(
      'Standalone CPython does not contain a working pip.\n' +
      (pipVersion.stderr || pipVersion.stdout || '')
    );
  }
  console.log('[ProvisionPython] ' + pipVersion.stdout.trim());

  // Install Scandium's explicit external-audio runtime requirements first.
  run(python, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-warn-script-location',
    '-r',
    REQUIREMENTS,
  ]);

  // Do not install RealtimeSTT's broad optional dependency set. In particular,
  // PyAudio belongs to the microphone worker and is unused by this application.
  run(python, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-warn-script-location',
    '--no-deps',
    'RealtimeSTT==1.2.0',
  ]);

  return { python, cleanEnv };
}

function verifyRuntime(python, cleanEnv, asset) {
  const verification = [
    'import importlib',
    'import importlib.metadata',
    'import inspect',
    'import os',
    'import sys',
    'assert sys.version_info[:2] == (3, 12), sys.version',
    'assert os.path.exists(sys.executable), sys.executable',
    'from RealtimeSTT import AudioToTextRecorder',
    'from faster_whisper import WhisperModel',
    'import ctranslate2',
    'import onnxruntime',
    'import scipy',
    'import soundfile',
    'import torch',
    'import webrtcvad',
    'assert "use_microphone" in inspect.signature(AudioToTextRecorder).parameters',
    'assert importlib.util.find_spec("pyaudio") is None, "PyAudio must not be installed for system-loopback mode"',
    'print("EXECUTABLE:", sys.executable)',
    'print("PREFIX:", sys.prefix)',
    'print("REALTIMESTT_VERSION:", importlib.metadata.version("RealtimeSTT"))',
    'print("FASTER_WHISPER_VERSION:", importlib.metadata.version("faster-whisper"))',
    'print("TORCH_VERSION:", torch.__version__)',
    'print("CTRANSLATE2_VERSION:", ctranslate2.__version__)',
    'print("ONNXRUNTIME_VERSION:", onnxruntime.__version__)',
    'print("EXTERNAL_AUDIO_RUNTIME_IMPORTS_OK")',
  ].join('\n');

  const check = spawnSync(python, ['-c', verification], {
    cwd: os.tmpdir(),
    env: cleanEnv,
    encoding: 'utf8',
    timeout: 120000,
  });

  if (check.status !== 0 || !check.stdout.includes('EXTERNAL_AUDIO_RUNTIME_IMPORTS_OK')) {
    throw new Error(
      'Standalone runtime verification failed.\n' +
      'Exit code: ' + check.status + '\n' +
      'STDOUT:\n' + (check.stdout || '') + '\n' +
      'STDERR:\n' + (check.stderr || '')
    );
  }

  console.log(check.stdout.trim());

  const metadata = {
    distribution: 'python-build-standalone',
    buildTag: BUILD_TAG,
    pythonVersion: PYTHON_VERSION,
    platform: process.platform,
    architecture: process.arch,
    archive: asset.name,
    archiveSha256: asset.sha256,
    executable: path.relative(TARGET, python),
    installedPackages: 'app/python-stt/requirements.txt + RealtimeSTT==1.2.0 (--no-deps)',
    microphoneCapture: false,
    verifiedWithCleanEnvironment: true,
    provisionedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(TARGET, 'PROVISIONED.json'),
    JSON.stringify(metadata, null, 2) + '\n',
    'utf8'
  );
}

function main() {
  const platformAssets = ASSETS[process.platform];
  const asset = platformAssets && platformAssets[process.arch];
  if (!asset) {
    throw new Error(
      'No pinned standalone CPython build for ' + process.platform + '/' + process.arch
    );
  }

  if (!fs.existsSync(REQUIREMENTS)) {
    throw new Error('Missing Python requirements file: ' + REQUIREMENTS);
  }

  console.log(
    '[ProvisionPython] Provisioning pinned relocatable CPython ' +
    PYTHON_VERSION + ' for ' + process.platform + '/' + process.arch
  );

  const result = provisionRuntime(asset);
  verifyRuntime(result.python, result.cleanEnv, asset);

  console.log('[ProvisionPython] Runtime provisioning and clean-environment verification passed.');
  console.log('[ProvisionPython] Bundled runtime: ' + TARGET);
}

try {
  main();
} catch (error) {
  console.error('[ProvisionPython] FATAL:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
