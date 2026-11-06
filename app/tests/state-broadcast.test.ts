import { describe, expect, it, vi } from 'vitest';
import { broadcastSharedStateToAppWindows, StateBroadcastWindow } from '../electron/domains/state-broadcast';

function createWindow(destroyed = false): StateBroadcastWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      send: vi.fn(),
    },
  };
}

describe('Shared-state renderer broadcast', () => {
  it('updates control, chat, and Dashboard windows', () => {
    const control = createWindow();
    const chat = createWindow();
    const dashboard = createWindow();
    const state = { hasApiKeys: { gemini: true } };

    broadcastSharedStateToAppWindows({
      getControlWindow: () => control,
      getChatWindow: () => chat,
      getDashboardWindow: () => dashboard,
    }, state);

    for (const win of [control, chat, dashboard]) {
      expect(win.webContents.send).toHaveBeenCalledOnce();
      expect(win.webContents.send).toHaveBeenCalledWith('shared-state-updated', state);
    }
  });

  it('skips missing or destroyed windows without preventing other updates', () => {
    const control = createWindow();
    const destroyedChat = createWindow(true);
    const dashboard = createWindow();
    const state = { showChat: false };

    broadcastSharedStateToAppWindows({
      getControlWindow: () => control,
      getChatWindow: () => destroyedChat,
      getDashboardWindow: () => dashboard,
    }, state);

    expect(control.webContents.send).toHaveBeenCalledWith('shared-state-updated', state);
    expect(destroyedChat.webContents.send).not.toHaveBeenCalled();
    expect(dashboard.webContents.send).toHaveBeenCalledWith('shared-state-updated', state);

    expect(() => broadcastSharedStateToAppWindows({
      getControlWindow: () => null,
      getChatWindow: () => null,
      getDashboardWindow: () => null,
    }, state)).not.toThrow();
  });
});
