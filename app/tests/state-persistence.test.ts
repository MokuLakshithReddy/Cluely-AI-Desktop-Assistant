import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../electron/domains/state';
import { decryptStoragePayload } from '../electron/services/storage-encryption';

describe('State persistence error reporting', () => {
  let directory: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it('does not restore stale transient persistence warnings from older state files', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-state-persistence-'));
    const stateFile = path.join(directory, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      showChat: false,
      persistenceError: 'stale warning from a previous run',
    }), 'utf8');

    const manager = new StateManager(stateFile, false);
    expect(manager.getState().showChat).toBe(false);
    expect(manager.getState().persistenceError).toBeUndefined();
  });

  it('ignores stale persisted app versions and does not persist runtime version metadata', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-state-version-'));
    const stateFile = path.join(directory, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      appVersion: '1.0.1',
      showChat: false,
    }), 'utf8');

    const manager = new StateManager(stateFile, false);
    expect(manager.getState().appVersion).not.toBe('1.0.1');
    expect(manager.getState().showChat).toBe(false);

    manager.flushSave();
    const raw = fs.readFileSync(stateFile, 'utf8');
    const persistedState = JSON.parse(decryptStoragePayload(raw));
    expect(persistedState).not.toHaveProperty('appVersion');
  });

  it('writes shared-state files with user-only POSIX permissions', () => {
    if (process.platform === 'win32') return;

    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-state-permissions-'));
    const stateFile = path.join(directory, 'state.json');
    const manager = new StateManager(stateFile, false);

    manager.patchState({ showChat: false });
    manager.flushSaveOrThrow();

    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
  });

  it('surfaces write failures, propagates critical flush errors, and clears the warning after recovery', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-state-persistence-'));
    const stateFile = path.join(directory, 'state.json');
    const manager = new StateManager(stateFile, false);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }) as any);

    manager.patchState({ showChat: false });
    manager.flushSave();

    expect(manager.getState().persistenceError).toMatch(/Local state could not be saved/);
    expect(() => manager.flushSaveOrThrow()).toThrow(/disk full/);

    writeSpy.mockRestore();
    manager.flushSaveOrThrow();
    expect(manager.getState().persistenceError).toBeNull();
    const raw = fs.readFileSync(stateFile, 'utf8');
    expect(JSON.parse(decryptStoragePayload(raw)).showChat).toBe(false);
    expect(fs.existsSync(stateFile)).toBe(true);
    const persistedState = JSON.parse(decryptStoragePayload(raw));
    expect(persistedState).not.toHaveProperty('persistenceError');
  });

  it('encrypts shared state at rest with AES-256-GCM envelope and refuses unencrypted writes even if patch attempts to disable', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-state-encrypt-'));
    const stateFile = path.join(directory, 'state.json');
    const manager = new StateManager(stateFile, false);

    // Attempting to patch encryptedStorageEnabled: false must be rejected/ignored; encryption remains permanently enforced
    manager.patchState({ showChat: true, activeMode: 'interview', encryptedStorageEnabled: false as any });
    manager.flushSave();

    const raw = fs.readFileSync(stateFile, 'utf8');
    expect(raw.startsWith('enc:v1:')).toBe(true);

    const decrypted = JSON.parse(decryptStoragePayload(raw));
    expect(decrypted.showChat).toBe(true);
    expect(decrypted.activeMode).toBe('interview');
    expect(decrypted.encryptedStorageEnabled).toBe(true);
  });

  it('automatically migrates legacy plaintext shared state file to AES-256-GCM encrypted format on load', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-state-migrate-'));
    const stateFile = path.join(directory, 'state.json');

    // Create an unencrypted legacy plaintext JSON state file
    const legacyPlaintext = JSON.stringify({
      showChat: true,
      activeMode: 'copilot',
      shortcuts: { toggleVisibility: 'CommandOrControl+Shift+Space' },
    });
    fs.writeFileSync(stateFile, legacyPlaintext, 'utf8');
    expect(fs.readFileSync(stateFile, 'utf8').startsWith('{')).toBe(true);

    // Loading the legacy file triggers automatic migration to AES-256-GCM
    const manager = new StateManager(stateFile, false);
    expect(manager.getState().showChat).toBe(true);

    // Verify on disk the file is now actively rewritten as enc:v1:
    const onDisk = fs.readFileSync(stateFile, 'utf8');
    expect(onDisk.startsWith('enc:v1:')).toBe(true);

    const decrypted = JSON.parse(decryptStoragePayload(onDisk));
    expect(decrypted.showChat).toBe(true);
  });

  it('purges sensitive in-memory state and records persistence error when legacy migration fails', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-state-failclosed-'));
    const stateFile = path.join(directory, 'state.json');

    const legacyPlaintext = JSON.stringify({
      showChat: true,
      activeMode: 'interview',
      secretKey: 'sensitive-unencrypted-token',
    });
    fs.writeFileSync(stateFile, legacyPlaintext, 'utf8');

    // Simulate disk failure during the save(true) migration re-write
    const originalWriteFileSync = fs.writeFileSync;
    let writeCount = 0;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((targetPath: any, data: any, options: any) => {
      writeCount++;
      if (writeCount > 0 && typeof targetPath === 'string' && targetPath.includes('state.json')) {
        throw new Error('EACCES: permission denied writing encrypted state');
      }
      return originalWriteFileSync(targetPath, data, options);
    }) as any);

    try {
      const manager = new StateManager(stateFile, false);
      const state = manager.getState();

      // Verify fail-closed behavior:
      // In-memory state was purged to INITIAL_STATE, persistence error is surfaced, and plaintext values were NOT retained
      expect(state.persistenceError).toMatch(/Fail-closed: Migration of legacy plaintext state to encrypted storage failed/);
      expect((state as any).secretKey).toBeUndefined();
      expect(state.activeMode).toBe('copilot'); // Reset to INITIAL_STATE default
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('suppresses active session and knowledge documents from disk when enterpriseMode is active', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-state-enterprise-'));
    const stateFile = path.join(directory, 'state.json');
    const manager = new StateManager(stateFile, false);

    manager.patchState({
      enterpriseMode: true,
      session: {
        id: 'sess_confidential_99',
        title: 'Confidential Enterprise Strategy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        durationSeconds: 10,
        mode: 'executive',
        audioInputLanguage: 'en',
        transcript: [
          {
            id: 't1',
            createdAt: new Date().toISOString(),
            relativeMs: 1000,
            role: 'me',
            status: 'ready',
            text: 'Projected Q4 revenue targets',
          },
        ],
        messages: [],
      },
      knowledgeDocs: [
        {
          id: 'doc_1',
          name: 'internal_secret.pdf',
          size: 1024,
          createdAt: new Date().toISOString(),
          status: 'ready',
          passages: [],
        },
      ],
    });
    manager.flushSave();

    const raw = fs.readFileSync(stateFile, 'utf8');
    const decrypted = JSON.parse(decryptStoragePayload(raw));
    expect(decrypted.enterpriseMode).toBe(true);
    expect(decrypted.session).toBeNull();
    expect(decrypted.knowledgeDocs).toEqual([]);
  });
});
