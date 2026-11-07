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
    expect(fs.existsSync(stateFile)).toBe(true);
    const persistedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(persistedState).not.toHaveProperty('persistenceError');
  });
});
