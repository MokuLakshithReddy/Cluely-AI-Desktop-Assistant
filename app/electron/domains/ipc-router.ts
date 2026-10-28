import { ipcMain, IpcMainInvokeEvent, IpcMainEvent, session, desktopCapturer } from 'electron';
import { stateManager } from './state';
import { screenshotService } from './screenshot';
import { windowCoordinator } from './windows';
import { SharedState } from '../../src/lib/types';

export class IpcRouter {
  public init() {
    this.setupDisplayMediaHandler();
    this.registerHandlers();
  }

  /**
   * Sets up system audio loopback capture handler on Windows
   */
  private setupDisplayMediaHandler() {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then(sources => {
          const primarySource = sources[0];
          if (!primarySource) {
            callback({});
            return;
          }
          // Enable loopback audio capture on Windows!
          callback({
            video: primarySource,
            audio: 'loopback',
          });
        })
        .catch(err => {
          console.error('[IpcRouter] Error selecting display media:', err);
          callback({});
        });
    });
  }

  /**
   * Validates sender frame origin to prevent injection
   */
  private validateOrigin(event: IpcMainInvokeEvent | IpcMainEvent) {
    const url = event.senderFrame?.url;
    if (!url) return;
    if (url.startsWith('file://') || url.startsWith('http://localhost:5173')) {
      return; // Authorized
    }
    throw new Error(`[IpcRouter] Rejected untrusted sender origin: ${url}`);
  }

  private registerHandlers() {
    // 1. Get Shared State
    ipcMain.handle('get-shared-state', (event): SharedState => {
      this.validateOrigin(event);
      return stateManager.getState();
    });

    // 2. Patch Shared State
    ipcMain.handle('patch-shared-state', (event, patch: Partial<SharedState>) => {
      this.validateOrigin(event);
      return stateManager.patchState(patch);
    });

    // 3. Capture Screenshot
    ipcMain.handle('capture-screenshot', async event => {
      this.validateOrigin(event);
      stateManager.patchState({ isCapturingScreenshot: true });
      try {
        const controlWin = windowCoordinator.getControlWindow();
        return await screenshotService.captureScreen(controlWin);
      } finally {
        stateManager.patchState({ isCapturingScreenshot: false });
      }
    });

    // 4. Toggle Stealth Mode
    ipcMain.handle('toggle-stealth-mode', (event, enable: boolean) => {
      this.validateOrigin(event);
      stateManager.patchState({ isStealthMode: enable });
      windowCoordinator.updateStealthMode(enable);
      return enable;
    });

    // 5. Window Dragging
    ipcMain.on('drag-control-window', (event, delta: { x: number; y: number }) => {
      this.validateOrigin(event);
      windowCoordinator.moveControlWindow(delta);
    });

    // 6. Resize Chat Window
    ipcMain.on('resize-chat-window', (event, height: number) => {
      this.validateOrigin(event);
      const chatWin = windowCoordinator.getChatWindow();
      if (chatWin && !chatWin.isDestroyed()) {
        const bounds = chatWin.getBounds();
        chatWin.setBounds({ ...bounds, height: Math.max(260, Math.min(height, 750)) });
      }
    });

    // 7. Open Dashboard
    ipcMain.on('open-dashboard', (event, tab?: string) => {
      this.validateOrigin(event);
      windowCoordinator.openDashboardWindow(tab);
    });

    // Broadcast state updates to all windows
    stateManager.subscribe(state => {
      const wins = [
        windowCoordinator.getControlWindow(),
        windowCoordinator.getChatWindow(),
      ];
      for (const win of wins) {
        if (win && !win.isDestroyed()) {
          win.webContents.send('shared-state-updated', state);
        }
      }
    });
  }
}

export const ipcRouter = new IpcRouter();

