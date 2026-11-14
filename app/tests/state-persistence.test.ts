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

  it('encrypts shared state at rest with AES-256-GCM envelope when encryptedStorageEnabled is active', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-state-encrypt-'));
    const stateFile = path.join(directory, 'state.json');
    const manager = new StateManager(stateFile, false);

    manager.patchState({ showChat: true, activeMode: 'interview', encryptedStorageEnabled: true });
    manager.flushSave();

    const raw = fs.readFileSync(stateFile, 'utf8');
    expect(raw.startsWith('enc:v1:')).toBe(true);

    const decrypted = JSON.parse(decryptStoragePayload(raw));
    expect(decrypted.showChat).toBe(true);
    expect(decrypted.activeMode).toBe('interview');
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
