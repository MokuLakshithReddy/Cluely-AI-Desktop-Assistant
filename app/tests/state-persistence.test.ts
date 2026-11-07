import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../electron/domains/state';

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
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).showChat).toBe(false);
    expect(fs.existsSync(stateFile)).toBe(true);
    const persistedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(persistedState).not.toHaveProperty('persistenceError');
  });
});
