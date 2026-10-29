import { BrowserWindow, screen, app } from 'electron';
import path from 'path';
import fs from 'fs';
import { stateManager } from './state';

export class WindowCoordinator {
  private controlWin: BrowserWindow | null = null;
  private chatWin: BrowserWindow | null = null;
  private dashboardWin: BrowserWindow | null = null;

  public init() {
    this.createControlWindow();
    this.createChatWindow();

    // Subscribe to state changes for content protection and visibility
    stateManager.subscribe(state => {
      this.updateStealthMode(state.isStealthMode);
      this.syncVisibility(state.showChat, state.showDashboard);
    });
  }

  private getPreloadPath(): string {
    const candidates = [
      path.join(app.getAppPath(), 'dist-electron/electron/preload.js'),
      path.join(app.getAppPath(), 'dist-electron/preload.js'),
      path.join(__dirname, '../preload.js'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return candidates[0];
  }

  private getRendererUrl(hash: string = ''): string {
    if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
      return `${process.env.VITE_DEV_SERVER_URL}#${hash}`;
    }
    const htmlPath = path.join(app.getAppPath(), 'dist/index.html');
    return `file://${htmlPath}#${hash}`;
  }

  public createControlWindow(): BrowserWindow {
    if (this.controlWin && !this.controlWin.isDestroyed()) return this.controlWin;

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workArea;

    // Center horizontally, placed near the top
    const winWidth = 490;
    const winHeight = 56;
    const initialX = Math.round((screenWidth - winWidth) / 2);
    const initialY = 24;

    this.controlWin = new BrowserWindow({
      title: 'Cluely Copilot',
      width: winWidth,
      height: winHeight,
      x: initialX,
      y: initialY,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      resizable: false,
      show: false,
      hasShadow: false,
      webPreferences: {
        preload: this.getPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.attachSecurityGuards(this.controlWin);

    this.controlWin.loadURL(this.getRendererUrl('control'));
    this.controlWin.once('ready-to-show', () => {
      this.controlWin?.show();
      stateManager.patchState({ isControlWindowLoaded: true });
    });

    this.controlWin.on('restore', () => {
      if (stateManager.getState().showChat && this.chatWin && !this.chatWin.isDestroyed()) {
        this.chatWin.show();
      }
    });

    this.controlWin.on('minimize', () => {
      if (this.chatWin && !this.chatWin.isDestroyed()) {
        this.chatWin.hide();
      }
    });

    this.updateStealthMode(stateManager.getState().isStealthMode);

    return this.controlWin;
  }

  public createChatWindow(): BrowserWindow {
    if (this.chatWin && !this.chatWin.isDestroyed()) return this.chatWin;

    const controlBounds = this.controlWin ? this.controlWin.getBounds() : { x: 500, y: 24, width: 490, height: 56 };
    const chatWidth = 490;
    const chatHeight = 520;
    const chatX = Math.round(controlBounds.x + (controlBounds.width - chatWidth) / 2);
    const chatY = controlBounds.y + controlBounds.height + 8;

    this.chatWin = new BrowserWindow({
      width: chatWidth,
      height: chatHeight,
      x: chatX,
      y: chatY,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      minWidth: 360,
      minHeight: 260,
      maxHeight: 750,
      show: false,
      hasShadow: true,
      webPreferences: {
        preload: this.getPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.attachSecurityGuards(this.chatWin);

    this.chatWin.loadURL(this.getRendererUrl('chat'));
    this.chatWin.once('ready-to-show', () => {
      this.chatWin?.show();
      stateManager.patchState({ isChatWindowLoaded: true });
    });

    this.updateStealthMode(stateManager.getState().isStealthMode);

    return this.chatWin;
  }

  private attachSecurityGuards(win: BrowserWindow | null) {
    if (!win) return;
    win.webContents.on('will-navigate', (event, url) => {
      try {
        const parsed = new URL(url);
        const isDev = !app.isPackaged && (parsed.origin === 'http://localhost:5173' || parsed.origin === 'http://127.0.0.1:5173');
        const isProd = parsed.protocol === 'file:';
        if (!isDev && !isProd) {
          event.preventDefault();
          console.warn('[WindowCoordinator] Blocked untrusted external navigation to:', url);
        }
      } catch {
        event.preventDefault();
      }
    });

    win.webContents.setWindowOpenHandler(() => {
      return { action: 'deny' };
    });
  }

  public openDashboardWindow(tab?: string): BrowserWindow {
    if (this.dashboardWin && !this.dashboardWin.isDestroyed()) {
      this.dashboardWin.show();
      this.dashboardWin.focus();
      if (tab) {
        this.dashboardWin.webContents.send('dashboard-switch-tab', tab);
      }
      return this.dashboardWin;
    }

    this.dashboardWin = new BrowserWindow({
      width: 900,
      height: 650,
      minWidth: 800,
      minHeight: 550,
      title: 'Cluely Copilot - Dashboard & Settings',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.getPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.attachSecurityGuards(this.dashboardWin);

    this.dashboardWin.loadURL(this.getRendererUrl(`dashboard${tab ? `?tab=${tab}` : ''}`));
    this.dashboardWin.once('ready-to-show', () => {
      this.dashboardWin?.show();
      stateManager.patchState({ isDashboardWindowLoaded: true, showDashboard: true });
    });

    this.dashboardWin.on('closed', () => {
      this.dashboardWin = null;
      stateManager.patchState({ isDashboardWindowLoaded: false, showDashboard: false });
    });

    return this.dashboardWin;
  }

  public updateStealthMode(isStealth: boolean) {
    // Windows: WDA_EXCLUDEFROMCAPTURE | macOS: NSWindowSharingNone
    try {
      this.controlWin?.setContentProtection(isStealth);
      this.chatWin?.setContentProtection(isStealth);
      this.dashboardWin?.setContentProtection(isStealth);
    } catch (e) {
      console.warn('[WindowCoordinator] Failed to set content protection:', e);
    }
  }

  public moveControlWindow(delta: { x: number; y: number }) {
    if (!this.controlWin || this.controlWin.isDestroyed()) return;
    const bounds = this.controlWin.getBounds();
    const newX = bounds.x + delta.x;
    const newY = bounds.y + delta.y;
    this.controlWin.setPosition(newX, newY);

    // Synchronize chat window position
    if (this.chatWin && !this.chatWin.isDestroyed()) {
      const chatBounds = this.chatWin.getBounds();
      const chatX = Math.round(newX + (bounds.width - chatBounds.width) / 2);
      const chatY = newY + bounds.height + 8;
      this.chatWin.setPosition(chatX, chatY);
    }
  }

  public syncVisibility(showChat: boolean, showDashboard: boolean) {
    if (this.chatWin && !this.chatWin.isDestroyed()) {
      if (showChat && !this.chatWin.isVisible()) {
        this.chatWin.show();
      } else if (!showChat && this.chatWin.isVisible()) {
        this.chatWin.hide();
      }
    }
  }

  public minimizeApp() {
    if (this.chatWin && !this.chatWin.isDestroyed() && this.chatWin.isVisible()) {
      this.chatWin.hide();
    }
    if (this.controlWin && !this.controlWin.isDestroyed()) {
      this.controlWin.minimize();
    }
  }

  public quitApp() {
    app.quit();
  }

  public getControlWindow(): BrowserWindow | null {
    return this.controlWin;
  }

  public getChatWindow(): BrowserWindow | null {
    return this.chatWin;
  }
}

export const windowCoordinator = new WindowCoordinator();
