import { BrowserWindow, screen, app } from 'electron';
import path from 'path';
import fs from 'fs';
import { stateManager } from './state';

export class WindowCoordinator {
  private controlWin: BrowserWindow | null = null;
  private chatWin: BrowserWindow | null = null;
  private dashboardWin: BrowserWindow | null = null;
  private unsubscribeState?: () => void;

  public init() {
    this.createControlWindow();
    this.createChatWindow();

    // Reinitialization after the last macOS window closes must not stack listeners.
    if (!this.unsubscribeState) {
      this.unsubscribeState = stateManager.subscribe(state => {
        this.updateStealthMode(state.isStealthMode);
        this.syncVisibility(state.showChat, state.showDashboard);
      });
    }
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
    const winWidth = 620;
    const winHeight = 58;
    const initialX = Math.round((screenWidth - winWidth) / 2);
    const initialY = 24;

    this.controlWin = new BrowserWindow({
      title: 'Scandium',
      width: winWidth,
      height: winHeight,
      x: initialX,
      y: initialY,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      resizable: false,
      maximizable: false,
      show: false,
      hasShadow: false,
      webPreferences: {
        preload: this.getPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });

    this.attachSecurityGuards(this.controlWin);

    const controlWindow = this.controlWin;
    controlWindow?.on('closed', () => {
      if (this.controlWin === controlWindow) {
        this.controlWin = null;
      }
      stateManager.patchState({ isControlWindowLoaded: false });
    });

    this.controlWin.loadURL(this.getRendererUrl('control'));
    this.controlWin.once('ready-to-show', () => {
      console.log('[CONTROL_READY] Showing floating control bar');
      this.controlWin?.show();
      this.controlWin?.focus();
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

    this.controlWin.on('move', () => {
      if (this.isSynchronizingWindows) return;
      if (!this.controlWin || this.controlWin.isDestroyed()) return;
      if (!this.chatWin || this.chatWin.isDestroyed()) return;
      if (!this.chatWin.isVisible()) return;

      this.isSynchronizingWindows = true;
      try {
        const bounds = this.controlWin.getBounds();
        const chatBounds = this.chatWin.getBounds();

        const bX = Number.isFinite(bounds?.x) ? bounds.x : 0;
        const bY = Number.isFinite(bounds?.y) ? bounds.y : 0;
        const bWidth = Number.isFinite(bounds?.width) ? bounds.width : 620;
        const bHeight = Number.isFinite(bounds?.height) ? bounds.height : 58;
        const targetWidth = 620;
        const currentHeight = Number.isFinite(chatBounds?.height)
          ? Math.min(750, Math.max(260, Math.round(chatBounds.height)))
          : 540;

        const chatX = Math.round(bX + (bWidth - targetWidth) / 2);
        const chatY = Math.round(bY + bHeight + 8);

        if (Number.isFinite(chatX) && Number.isFinite(chatY)) {
          this.chatWin.setBounds({
            x: chatX,
            y: chatY,
            width: targetWidth,
            height: currentHeight,
          });
        }
      } catch (err) {
        console.warn('[WindowCoordinator] Suppressed position sync error in move listener:', err);
      } finally {
        this.isSynchronizingWindows = false;
      }
    });

    this.updateStealthMode(stateManager.getState().isStealthMode);

    return this.controlWin;
  }

  public createChatWindow(): BrowserWindow {
    if (this.chatWin && !this.chatWin.isDestroyed()) return this.chatWin;

    const controlBounds = this.controlWin ? this.controlWin.getBounds() : { x: 500, y: 24, width: 620, height: 58 };
    const chatWidth = 620;
    const chatHeight = 540;
    const cbX = Number.isFinite(controlBounds?.x) ? controlBounds.x : 500;
    const cbY = Number.isFinite(controlBounds?.y) ? controlBounds.y : 24;
    const cbW = Number.isFinite(controlBounds?.width) ? controlBounds.width : 620;
    const cbH = Number.isFinite(controlBounds?.height) ? controlBounds.height : 58;
    const chatX = Math.round(cbX + (cbW - chatWidth) / 2);
    const chatY = Math.round(cbY + cbH + 8);

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
      minWidth: 620,
      maxWidth: 620,
      minHeight: 260,
      maxHeight: 750,
      maximizable: false,
      show: false,
      hasShadow: true,
      webPreferences: {
        preload: this.getPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });

    this.attachSecurityGuards(this.chatWin);

    this.chatWin.on('resize', () => {
      if (this.isSynchronizingWindows) return;
      if (!this.chatWin || this.chatWin.isDestroyed()) return;
      try {
        const bounds = this.chatWin.getBounds();
        if (bounds && bounds.width !== 620) {
          const clampedH = Math.min(750, Math.max(260, bounds.height));
          this.chatWin.setSize(620, clampedH);
        }
      } catch (err) {
        console.warn('[WindowCoordinator] Suppressed resize clamp error:', err);
      }
    });

    const chatWindow = this.chatWin;
    chatWindow?.on('closed', () => {
      if (this.chatWin === chatWindow) {
        this.chatWin = null;
      }
      stateManager.patchState({ isChatWindowLoaded: false });
    });

    this.chatWin.loadURL(this.getRendererUrl('chat'));
    this.chatWin.once('ready-to-show', () => {
      console.log('[CHAT_READY] Showing chat panel');
      this.chatWin?.show();
      this.chatWin?.focus();
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
      title: 'Scandium - Dashboard & Settings',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.getPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });

    this.attachSecurityGuards(this.dashboardWin);

    this.dashboardWin.loadURL(this.getRendererUrl(`dashboard${tab ? `?tab=${tab}` : ''}`));
    this.dashboardWin.once('ready-to-show', () => {
      console.log('[DASHBOARD_READY] Showing dashboard window');
      this.dashboardWin?.show();
      this.dashboardWin?.focus();
      stateManager.patchState({ isDashboardWindowLoaded: true, showDashboard: true });
    });

    this.dashboardWin.on('closed', () => {
      this.dashboardWin = null;
      stateManager.patchState({ isDashboardWindowLoaded: false, showDashboard: false });
    });

    return this.dashboardWin;
  }

  public updateStealthMode(isStealth: boolean) {
    // Windows: WDA_EXCLUDEFROMCAPTURE | macOS: NSWindowSharingNone.
    // Optional chaining only checks for null; Electron methods still throw on destroyed windows.
    const windows = [this.controlWin, this.chatWin, this.dashboardWin];
    for (const win of windows) {
      if (!win || win.isDestroyed()) continue;
      try {
        win.setContentProtection(isStealth);
      } catch (e) {
        console.warn('[WindowCoordinator] Failed to set content protection:', e);
      }
    }
  }

  private isSynchronizingWindows = false;

  public moveControlWindow(delta: { x: number; y: number }) {
    if (!this.controlWin || this.controlWin.isDestroyed()) return;
    const dx = Number(delta?.x);
    const dy = Number(delta?.y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

    this.isSynchronizingWindows = true;
    try {
      const bounds = this.controlWin.getBounds();
      const bX = Number.isFinite(bounds?.x) ? bounds.x : 0;
      const bY = Number.isFinite(bounds?.y) ? bounds.y : 0;
      const bWidth = 620;
      const bHeight = 58;

      const newX = Math.round(bX + dx);
      const newY = Math.round(bY + dy);

      if (Number.isFinite(newX) && Number.isFinite(newY)) {
        this.controlWin.setBounds({
          x: newX,
          y: newY,
          width: bWidth,
          height: bHeight,
        });
      }

      // Synchronize chat window position if visible
      if (this.chatWin && !this.chatWin.isDestroyed() && this.chatWin.isVisible()) {
        const chatBounds = this.chatWin.getBounds();
        const targetWidth = 620;
        const currentHeight = Number.isFinite(chatBounds?.height)
          ? Math.min(750, Math.max(260, Math.round(chatBounds.height)))
          : 540;
        const chatX = Math.round(newX + (bWidth - targetWidth) / 2);
        const chatY = Math.round(newY + bHeight + 8);
        if (Number.isFinite(chatX) && Number.isFinite(chatY)) {
          this.chatWin.setBounds({
            x: chatX,
            y: chatY,
            width: targetWidth,
            height: currentHeight,
          });
        }
      }
    } catch (err) {
      console.warn('[WindowCoordinator] Suppressed position sync error in moveControlWindow:', err);
    } finally {
      this.isSynchronizingWindows = false;
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
    if (!this.controlWin || this.controlWin.isDestroyed()) {
      this.controlWin = null;
      return null;
    }
    return this.controlWin;
  }

  public getChatWindow(): BrowserWindow | null {
    if (!this.chatWin || this.chatWin.isDestroyed()) {
      this.chatWin = null;
      return null;
    }
    return this.chatWin;
  }

  public getDashboardWindow(): BrowserWindow | null {
    if (!this.dashboardWin || this.dashboardWin.isDestroyed()) {
      this.dashboardWin = null;
      return null;
    }
    return this.dashboardWin;
  }
}

export const windowCoordinator = new WindowCoordinator();
