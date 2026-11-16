import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  windows: [] as any[],
  stateListeners: [] as Array<(state: any) => void>,
  stateManager: {
    getState: vi.fn(),
    patchState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

vi.mock('electron', () => {
  class FakeBrowserWindow {
    options: any;
    destroyed = false;
    visible = false;
    minimized = false;
    handlers = new Map<string, Array<(...args: any[]) => void>>();
    webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
    };
    loadURL = vi.fn();
    setContentProtection = vi.fn();
    focus = vi.fn();
    setPosition = vi.fn();
    setBounds = vi.fn();

    constructor(options: any) {
      this.options = options;
      mocks.windows.push(this);
    }

    on(event: string, callback: (...args: any[]) => void) {
      const callbacks = this.handlers.get(event) || [];
      callbacks.push(callback);
      this.handlers.set(event, callbacks);
      return this;
    }

    once(event: string, callback: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => {
        const callbacks = (this.handlers.get(event) || []).filter(item => item !== wrapped);
        this.handlers.set(event, callbacks);
        callback(...args);
      };
      return this.on(event, wrapped);
    }

    emit(event: string, ...args: any[]) {
      for (const callback of [...(this.handlers.get(event) || [])]) {
        callback(...args);
      }
    }

    close() {
      this.destroyed = true;
      this.emit('closed');
    }

    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    getBounds() { return { x: 100, y: 24, width: 490, height: 56 }; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    minimize() { this.minimized = true; }
    restore() { this.minimized = false; }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getPrimaryDisplay: () => ({ workArea: { width: 1440, height: 900 } }),
    },
    app: {
      getAppPath: () => '/tmp/cluely-window-test',
      isPackaged: false,
    },
  };
});

vi.mock('../electron/domains/state', () => ({
  stateManager: mocks.stateManager,
}));

import { WindowCoordinator } from '../electron/domains/windows';

describe('WindowCoordinator macOS close-all recovery', () => {
  beforeEach(() => {
    mocks.windows.splice(0);
    mocks.stateListeners.splice(0);
    mocks.stateManager.getState.mockReturnValue({
      isStealthMode: false,
      showChat: true,
      showDashboard: false,
    });
    mocks.stateManager.patchState.mockReset();
    mocks.stateManager.subscribe.mockReset();
    mocks.stateManager.subscribe.mockImplementation((listener: (state: any) => void) => {
      mocks.stateListeners.push(listener);
      return vi.fn();
    });
  });

  it('clears closed control/chat references and recreates both windows on reinitialization', () => {
    const coordinator = new WindowCoordinator();
    coordinator.init();

    const firstControl = coordinator.getControlWindow() as any;
    const firstChat = coordinator.getChatWindow() as any;
    expect(firstControl).toBeTruthy();
    expect(firstChat).toBeTruthy();
    expect(mocks.windows).toHaveLength(2);

    firstControl.close();
    firstChat.close();

    expect(coordinator.getControlWindow()).toBeNull();
    expect(coordinator.getChatWindow()).toBeNull();

    coordinator.init();

    expect(mocks.windows).toHaveLength(4);
    expect(coordinator.getControlWindow()).not.toBe(firstControl);
    expect(coordinator.getChatWindow()).not.toBe(firstChat);
    expect(mocks.stateManager.subscribe).toHaveBeenCalledOnce();
  });

  it('keeps initialization idempotent and does not register duplicate state listeners', () => {
    const coordinator = new WindowCoordinator();

    coordinator.init();
    coordinator.init();

    expect(mocks.windows).toHaveLength(2);
    expect(mocks.stateManager.subscribe).toHaveBeenCalledOnce();
  });

  it('returns null for destroyed windows even before their closed event is delivered', () => {
    const coordinator = new WindowCoordinator();
    coordinator.init();

    const control = coordinator.getControlWindow() as any;
    control.destroyed = true;

    expect(coordinator.getControlWindow()).toBeNull();
  });

  it('moveControlWindow rounds fractional coordinates and syncs visible chat window', () => {
    const coordinator = new WindowCoordinator();
    coordinator.init();

    const control = coordinator.getControlWindow() as any;
    const chat = coordinator.getChatWindow() as any;
    chat.visible = true;

    coordinator.moveControlWindow({ x: 12.7, y: -4.3 });

    expect(control.setBounds).toHaveBeenCalledWith({
      x: Math.round(100 + 12.7),
      y: Math.round(24 - 4.3),
      width: 620,
      height: 58,
    });
    expect(chat.setBounds).toHaveBeenCalled();
    const [bounds] = chat.setBounds.mock.calls[0];
    expect(Number.isInteger(bounds.x)).toBe(true);
    expect(Number.isInteger(bounds.y)).toBe(true);
    expect(bounds.width).toBe(620);
    expect(Number.isInteger(bounds.height)).toBe(true);
  });

  it('moveControlWindow does not reposition chat window when chat is hidden', () => {
    const coordinator = new WindowCoordinator();
    coordinator.init();

    const chat = coordinator.getChatWindow() as any;
    chat.visible = false;

    coordinator.moveControlWindow({ x: 10, y: 10 });
    expect(chat.setBounds).not.toHaveBeenCalled();
  });

  it('moveControlWindow safely ignores invalid or NaN deltas', () => {
    const coordinator = new WindowCoordinator();
    coordinator.init();

    const control = coordinator.getControlWindow() as any;
    coordinator.moveControlWindow({ x: NaN, y: 10 });
    expect(control.setBounds).not.toHaveBeenCalled();
  });
});
