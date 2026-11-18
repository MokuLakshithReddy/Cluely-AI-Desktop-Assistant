import { globalShortcut, app } from 'electron';
import { stateManager } from './state';
import { windowCoordinator } from './windows';

export class ShortcutManager {
  private emergencyStopHandler?: () => void;
  private registeredShortcuts: Map<string, string> = new Map();
  private lastShortcutsJson: string = '';

  public setEmergencyStopHandler(handler: () => void): void {
    this.emergencyStopHandler = handler;
  }

  public init() {
    this.registerAll();

    // Re-register ONLY if shortcuts configuration actually changed
    stateManager.subscribe(state => {
      const shortcutsJson = JSON.stringify(state.shortcuts);
      if (shortcutsJson !== this.lastShortcutsJson) {
        this.lastShortcutsJson = shortcutsJson;
        this.syncShortcuts(state.shortcuts);
      }
    });

    app.on('will-quit', () => {
      this.unregisterAll();
    });
  }

  private registerAll() {
    const shortcuts = stateManager.getState().shortcuts;
    this.lastShortcutsJson = JSON.stringify(shortcuts);
    this.syncShortcuts(shortcuts);
  }

  private registerShortcutSafe(name: string, accelerator: string | undefined, handler: () => void): void {
    if (!accelerator || typeof accelerator !== 'string') return;
    try {
      globalShortcut.register(accelerator, handler);
      this.registeredShortcuts.set(name, accelerator);
    } catch (err) {
      console.warn(`[ShortcutManager] Failed to register accelerator "${accelerator}" for "${name}":`, err);
    }
  }

  public syncShortcuts(shortcuts: Record<string, string>) {
    this.unregisterAll();

    // 1. Toggle visibility
    this.registerShortcutSafe('toggleVisibility', shortcuts.toggleVisibility, () => {
      const state = stateManager.getState();
      stateManager.patchState({ showChat: !state.showChat });
    });

    // 2. Ask / Capture
    this.registerShortcutSafe('ask', shortcuts.ask, () => {
      const chatWin = windowCoordinator.getChatWindow();
      if (chatWin && !chatWin.isDestroyed()) {
        chatWin.webContents.send('shortcut-action', 'ask');
      }
    });

    // 3. Clear / Collapse
    this.registerShortcutSafe('clear', shortcuts.clear, () => {
      const chatWin = windowCoordinator.getChatWindow();
      if (chatWin && !chatWin.isDestroyed()) {
        chatWin.webContents.send('shortcut-action', 'clear');
      }
    });

    // 4. Emergency Stop (privacy control: stop streams and abort in-flight work)
    this.registerShortcutSafe('emergencyStop', shortcuts.emergencyStop, () => {
      this.emergencyStopHandler?.();
    });

    // 5. Toggle Session
    this.registerShortcutSafe('toggleSession', shortcuts.toggleSession, () => {
      const state = stateManager.getState();
      stateManager.patchState({ isRecording: !state.isRecording });
    });

    // 6. Directional Nudge (80px)
    this.registerShortcutSafe('moveUp', shortcuts.moveUp, () => {
      windowCoordinator.moveControlWindow({ x: 0, y: -80 });
    });
    this.registerShortcutSafe('moveDown', shortcuts.moveDown, () => {
      windowCoordinator.moveControlWindow({ x: 0, y: 80 });
    });
    this.registerShortcutSafe('moveLeft', shortcuts.moveLeft, () => {
      windowCoordinator.moveControlWindow({ x: -80, y: 0 });
    });
    this.registerShortcutSafe('moveRight', shortcuts.moveRight, () => {
      windowCoordinator.moveControlWindow({ x: 80, y: 0 });
    });
  }

  public unregisterAll() {
    globalShortcut.unregisterAll();
    this.registeredShortcuts.clear();
  }
}

export const shortcutManager = new ShortcutManager();

