#!/usr/bin/env node
'use strict';

/**
 * Builds a relocatable CPython runtime from a checksum-pinned python-build-standalone
 * release, installs the STT requirements into that runtime, and verifies native imports
 * with host Python search paths removed.
 */
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const targetPythonDir = path.join(repoRoot, 'app', 'resources', 'python');
const requirementsPath = path.join(repoRoot, 'app', 'python-stt', 'requirements.txt');
const releaseTag = '20261110';
const pythonVersion = '3.12.16';

const assets = {
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

function log(message) {
  console.log('[ProvisionPython] ' + message);
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  }).trim();
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function getPythonExecutable() {
  return process.platform === 'win32'
    ? path.join(targetPythonDir, 'python.exe')
    : path.join(targetPythonDir, 'bin', 'python3');
}

function findFiles(root, predicate, found = []) {
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) findFiles(fullPath, predicate, found);
    else if (entry.isFile() && predicate(fullPath)) found.push(fullPath);
  }
  return found;
}

function clearRuntimeDirectory() {
  fs.mkdirSync(targetPythonDir, { recursive: true });
  for (const name of fs.readdirSync(targetPythonDir)) {
    if (name === 'README.md') continue;
    fs.rmSync(path.join(targetPythonDir, name), { recursive: true, force: true });
  }
}

function provisionPortAudio(sitePackages) {
  const pyaudioDir = path.join(sitePackages, 'pyaudio');
  if (!fs.existsSync(pyaudioDir)) {
    throw new Error('PyAudio package directory is missing after requirements installation: ' + pyaudioDir);
  }

  const extensions = findFiles(pyaudioDir, (file) =>
    file.startsWith('_portaudio') && (file.endsWith('.so') || file.endsWith('.pyd'))
  );
  if (extensions.length === 0) {
    throw new Error('PyAudio native extension was not found under ' + pyaudioDir);
  }

  if (process.platform === 'linux') {
    let linkerCache = '';
    try {
      linkerCache = capture('ldconfig', ['-p']);
    } catch (error) {
      throw new Error('ldconfig is required to locate the system PortAudio library: ' + error.message);
    }
    const libraryLine = linkerCache.split(/\r?\n/).find((line) => /libportaudio\.so\.2/.test(line) && line.includes('=>'));
    if (!libraryLine) {
      throw new Error('libportaudio.so.2 was not found. Install portaudio19-dev and libportaudio2 first.');
    }
    const sourceLibrary = libraryLine.split('=>').pop().trim();
    const bundledLibrary = path.join(pyaudioDir, 'libportaudio.so.2');
    fs.copyFileSync(fs.realpathSync(sourceLibrary), bundledLibrary);
    for (const extension of extensions) {
      run('patchelf', ['--set-rpath', '$ORIGIN', extension]);
    }
    log('Bundled libportaudio.so.2 beside the PyAudio extension and set an origin-relative RPATH.');
    return;
  }

  if (process.platform === 'darwin') {
    const brewPrefix = capture('brew', ['--prefix', 'portaudio']);
    const libDir = path.join(brewPrefix, 'lib');
    const candidateNames = ['libportaudio.2.dylib', 'libportaudio.dylib'];
    const sourceLibrary = candidateNames
      .map((name) => path.join(libDir, name))
      .find((file) => fs.existsSync(file));
    if (!sourceLibrary) {
      throw new Error('Homebrew PortAudio dylib was not found under ' + libDir);
    }

    const bundledName = 'libportaudio.2.dylib';
    const bundledLibrary = path.join(pyaudioDir, bundledName);
    fs.copyFileSync(fs.realpathSync(sourceLibrary), bundledLibrary);

    for (const extension of extensions) {
      const dependencies = capture('otool', ['-L', extension]);
      const portAudioDependency = dependencies
        .split(/\r?\n/)
        .map((line) => line.trim().split(' (')[0].trim())
        .find((line) => /libportaudio[^/]*\.dylib$/.test(line) || /libportaudio.*\.dylib$/.test(line));
      if (!portAudioDependency) {
        throw new Error('Could not identify the PortAudio dependency in ' + extension);
      }
      run('install_name_tool', ['-change', portAudioDependency, '@loader_path/' + bundledName, extension]);
    }
    log('Bundled libportaudio.2.dylib beside the PyAudio extension and patched its install name.');
    return;
  }

  if (process.platform === 'win32') {
    // The official Windows PyAudio wheel bundles its PortAudio runtime dependency.
    log('Using the official Windows PyAudio wheel with its bundled PortAudio runtime.');
    return;
  }

  throw new Error('Unsupported platform for PortAudio runtime bundling: ' + process.platform);
}

function main() {
  const platformAssets = assets[process.platform];
  const targetAsset = platformAssets && platformAssets[process.arch];
  if (!targetAsset) {
    throw new Error('No pinned CPython ' + pythonVersion + ' runtime is available for ' +
      process.platform + '/' + process.arch);
  }

  log('Provisioning CPython ' + pythonVersion + ' for ' + process.platform + '/' + process.arch + '.');
  clearRuntimeDirectory();

  const archivePath = path.join(os.tmpdir(), targetAsset.name);
  const archiveUrl = 'https://github.com/astral-sh/python-build-standalone/releases/download/' +
    releaseTag + '/' + encodeURIComponent(targetAsset.name);

  log('Downloading checksum-pinned standalone runtime: ' + targetAsset.name);
  run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
    '--fail', '--location', '--retry', '3', '--output', archivePath, archiveUrl,
  ]);

  const actualDigest = sha256File(archivePath);
  if (actualDigest !== targetAsset.sha256) {
    throw new Error('CPython archive SHA-256 mismatch. Expected ' + targetAsset.sha256 + ', got ' + actualDigest);
  }
  log('CPython archive SHA-256 verified.');

  run('tar', ['-xzf', archivePath, '-C', targetPythonDir, '--strip-components=1']);
  fs.rmSync(archivePath, { force: true });

  const pythonExe = getPythonExecutable();
  if (!fs.existsSync(pythonExe)) {
    throw new Error('Standalone CPython executable was not found at ' + pythonExe);
  }

  // Install into the standalone distribution itself. No runner .venv or absolute build path is copied.
  try {
    run(pythonExe, ['-m', 'pip', '--version']);
  } catch {
    run(pythonExe, ['-m', 'ensurepip', '--upgrade']);
  }
  run(pythonExe, [
    '-m', 'pip', 'install', '--no-cache-dir', '--disable-pip-version-check',
    '-r', requirementsPath,
  ]);

  const sitePackages = capture(pythonExe, [
    '-c', "import sysconfig; print(sysconfig.get_paths()['purelib'])",
  ]);
  if (!path.isAbsolute(sitePackages) || !fs.existsSync(sitePackages)) {
    throw new Error('Standalone Python resolved an invalid site-packages directory: ' + sitePackages);
  }

  provisionPortAudio(sitePackages);

  const smokeScript = [
    'import os, sys',
    'print("RUNNING_EXECUTABLE:", sys.executable)',
    'print("SYS_PREFIX:", sys.prefix)',
    'assert os.path.exists(sys.executable), "Python executable must exist"',
    'import pyaudio',
    'assert pyaudio.get_portaudio_version() is not None, "PortAudio must load"',
    'import RealtimeSTT',
    'import faster_whisper',
    'import ctranslate2',
    'import onnxruntime',
    'print("REALTIME_STT_STANDALONE_SUCCESS")',
  ].join('\n');

  // Do not inherit Python, virtualenv, or dynamic-loader paths from the CI runner.
  const cleanPath = process.platform === 'win32'
    ? (process.env.SystemRoot || 'C:\\Windows') + '\\System32'
    : '/usr/bin:/bin:/usr/sbin:/sbin';
  const testEnv = {
    PATH: cleanPath,
    SYSTEMROOT: process.env.SystemRoot || 'C:\\Windows',
    WINDIR: process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows',
    TEMP: process.env.TEMP || os.tmpdir(),
    TMP: process.env.TMP || os.tmpdir(),
    HOME: process.env.HOME || os.tmpdir(),
  };

  log('Running isolated runtime import verification without runner Python or loader paths.');
  const check = spawnSync(pythonExe, ['-c', smokeScript], {
    cwd: os.tmpdir(),
    env: testEnv,
    encoding: 'utf8',
    timeout: 90000,
  });

  if (check.status !== 0 || !check.stdout || !check.stdout.includes('REALTIME_STT_STANDALONE_SUCCESS')) {
    console.error('[ProvisionPython] Clean-runtime verification failed.');
    console.error('Exit code:', check.status, 'signal:', check.signal);
    console.error('STDOUT:', check.stdout);
    console.error('STDERR:', check.stderr);
    throw new Error('Bundled CPython runtime failed its isolated RealtimeSTT dependency check.');
  }

  log('ISOLATED RUNTIME VERIFICATION PASSED.');
  process.stdout.write(check.stdout);

  const metadata = {
    pythonVersion,
    pythonBuildRelease: releaseTag,
    archive: targetAsset.name,
    archiveSha256: targetAsset.sha256,
    platform: process.platform,
    arch: process.arch,
    provisionedAt: new Date().toISOString(),
    executable: process.platform === 'win32' ? 'python.exe' : 'bin/python3',
    isRelocatable: true,
    cleanRuntimeVerified: true,
    portAudioBundled: true,
  };
  fs.writeFileSync(
    path.join(targetPythonDir, 'PROVISIONED.json'),
    JSON.stringify(metadata, null, 2) + '\n',
    'utf8'
  );

  log('Standalone CPython and RealtimeSTT dependencies are ready in ' + targetPythonDir + '.');
}

try {
  main();
} catch (error) {
  console.error('[ProvisionPython] FATAL:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
