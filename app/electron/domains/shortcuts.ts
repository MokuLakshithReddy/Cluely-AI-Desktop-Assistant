import { globalShortcut, app } from 'electron';
import { stateManager } from './state';
import { windowCoordinator } from './windows';

export class ShortcutManager {
  private registeredShortcuts: Map<string, string> = new Map();

  public init() {
    this.registerAll();

    // Re-register if shortcuts config changes
    stateManager.subscribe(state => {
      this.syncShortcuts(state.shortcuts);
    });

    app.on('will-quit', () => {
      this.unregisterAll();
    });
  }

  private registerAll() {
    const shortcuts = stateManager.getState().shortcuts;
    this.syncShortcuts(shortcuts);
  }

  public syncShortcuts(shortcuts: Record<string, string>) {
    this.unregisterAll();

    // 1. Toggle visibility
    if (shortcuts.toggleVisibility) {
      globalShortcut.register(shortcuts.toggleVisibility, () => {
        const state = stateManager.getState();
        stateManager.patchState({ showChat: !state.showChat });
      });
      this.registeredShortcuts.set('toggleVisibility', shortcuts.toggleVisibility);
    }

    // 2. Ask / Capture
    if (shortcuts.ask) {
      globalShortcut.register(shortcuts.ask, () => {
        const chatWin = windowCoordinator.getChatWindow();
        if (chatWin && !chatWin.isDestroyed()) {
          chatWin.webContents.send('shortcut-action', 'ask');
        }
      });
      this.registeredShortcuts.set('ask', shortcuts.ask);
    }

    // 3. Clear / Collapse
    if (shortcuts.clear) {
      globalShortcut.register(shortcuts.clear, () => {
        const chatWin = windowCoordinator.getChatWindow();
        if (chatWin && !chatWin.isDestroyed()) {
          chatWin.webContents.send('shortcut-action', 'clear');
        }
      });
      this.registeredShortcuts.set('clear', shortcuts.clear);
    }

    // 4. Toggle Session
    if (shortcuts.toggleSession) {
      globalShortcut.register(shortcuts.toggleSession, () => {
        const state = stateManager.getState();
        stateManager.patchState({ isRecording: !state.isRecording });
      });
      this.registeredShortcuts.set('toggleSession', shortcuts.toggleSession);
    }

    // 5. Directional Nudge (80px)
    if (shortcuts.moveUp) {
      globalShortcut.register(shortcuts.moveUp, () => {
        windowCoordinator.moveControlWindow({ x: 0, y: -80 });
      });
      this.registeredShortcuts.set('moveUp', shortcuts.moveUp);
    }
    if (shortcuts.moveDown) {
      globalShortcut.register(shortcuts.moveDown, () => {
        windowCoordinator.moveControlWindow({ x: 0, y: 80 });
      });
      this.registeredShortcuts.set('moveDown', shortcuts.moveDown);
    }
    if (shortcuts.moveLeft) {
      globalShortcut.register(shortcuts.moveLeft, () => {
        windowCoordinator.moveControlWindow({ x: -80, y: 0 });
      });
      this.registeredShortcuts.set('moveLeft', shortcuts.moveLeft);
    }
    if (shortcuts.moveRight) {
      globalShortcut.register(shortcuts.moveRight, () => {
        windowCoordinator.moveControlWindow({ x: 80, y: 0 });
      });
      this.registeredShortcuts.set('moveRight', shortcuts.moveRight);
    }
  }

  public unregisterAll() {
    globalShortcut.unregisterAll();
    this.registeredShortcuts.clear();
  }
}

export const shortcutManager = new ShortcutManager();

