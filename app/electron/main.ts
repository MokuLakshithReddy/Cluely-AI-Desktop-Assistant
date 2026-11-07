import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { windowCoordinator } from './domains/windows';
import { shortcutManager } from './domains/shortcuts';
import { ipcRouter } from './domains/ipc-router';
import { stateManager } from './domains/state';

let isQuitting = false;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForPackagedWindowBridge(
  win: BrowserWindow | null,
  expectedRoute: string,
  timeoutMs = 35000
): Promise<{ route: string; bridgeReady: boolean; ipcReady: boolean }> {
  if (!win || win.isDestroyed()) {
    throw new Error('Packaged smoke could not find the ' + expectedRoute + ' BrowserWindow.');
  }

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error('Packaged ' + expectedRoute + ' window was destroyed before renderer readiness.');
    }

    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const bridge = window.desktopBridge;
        if (document.readyState !== 'complete' || !bridge ||
            typeof bridge.getSharedState !== 'function') return null;
        const state = await bridge.getSharedState();
        const route = window.location.hash.replace(/^#\\/?/, '').split('?')[0];
        return {
          route,
          bridgeReady: true,
          ipcReady: Boolean(state && typeof state === 'object' && 'isRecording' in state)
        };
      })()`);
      if (result && result.route === expectedRoute &&
          result.bridgeReady === true && result.ipcReady === true) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }

  const detail = lastError instanceof Error ? ': ' + lastError.message : '';
  throw new Error('Timed out waiting for packaged ' + expectedRoute +
    ' renderer/preload/IPC readiness' + detail);
}

async function runPackagedSmoke(): Promise<void> {
  try {
    const control = await waitForPackagedWindowBridge(windowCoordinator.getControlWindow(), 'control');
    const chat = await waitForPackagedWindowBridge(windowCoordinator.getChatWindow(), 'chat');
    console.log('[PACKAGED_SMOKE_READY]', JSON.stringify({ control, chat }));
  } catch (error: any) {
    console.error('[PACKAGED_SMOKE_FAILED]', error?.stack || error?.message || error);
    process.exitCode = 1;
    app.quit();
  }
}

// Prevent multiple instances (bypassed in smoke tests to avoid lock contention with the harness).
const gotSingleInstanceLock = process.env.SMOKE_TEST === 'true' ? true : app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const controlWin = windowCoordinator.getControlWindow();
    if (controlWin) {
      if (controlWin.isMinimized()) controlWin.restore();
      controlWin.focus();
    }
  });

  app.whenReady().then(() => {
    ipcRouter.init();
    shortcutManager.setEmergencyStopHandler(() => ipcRouter.emergencyStop());
    windowCoordinator.init();
    shortcutManager.init();

    console.log('[APP_READY] Cluely Desktop Coordinator Ready');

    if (process.env.SMOKE_TEST === 'true') {
      if (process.env.SMOKE_TEST_MODE === 'packaged') {
        void runPackagedSmoke();
      } else {
        try {
          const { runDesktopE2E } = require(path.join(app.getAppPath(), 'tests', 'electron-e2e.cjs'));
          runDesktopE2E({ windowCoordinator }).then(
            () => console.log('[E2E_COMPLETE] Electron UI, preload bridge, IPC, and persistence flows passed.'),
            (error: any) => console.log('[E2E_FAILED]', error?.stack || error?.message || error)
          );
        } catch (error: any) {
          console.log('[E2E_FAILED]', error?.stack || error?.message || error);
        }
      }
    }

    if (process.env.SMOKE_TEST === 'true') {
      const suppliedTrigger = process.env.SMOKE_TEST_SHUTDOWN_TRIGGER;
      const shutdownTrigger =
        process.env.SMOKE_TEST_MODE === 'packaged' && suppliedTrigger && path.isAbsolute(suppliedTrigger)
          ? suppliedTrigger
          : path.join(app.getAppPath(), '.smoke-shutdown.trigger');
      if (fs.existsSync(shutdownTrigger)) {
        try { fs.unlinkSync(shutdownTrigger); } catch {}
      }

      const checkInterval = setInterval(() => {
        if (fs.existsSync(shutdownTrigger)) {
          clearInterval(checkInterval);
          try { fs.unlinkSync(shutdownTrigger); } catch {}
          console.log('[APP_CLEAN_SHUTDOWN] Graceful shutdown command received via trigger.');
          isQuitting = true;
          app.quit();
        }
      }, 100);
    }

    app.on('activate', () => {
      if (!windowCoordinator.getControlWindow()) {
        windowCoordinator.init();
      }
    });
  });

  app.on('before-quit', () => {
    console.log('[APP_BEFORE_QUIT] Application lifecycle before-quit triggered.');
    stateManager.flushSave();
  });

  app.on('will-quit', () => {
    console.log('[APP_WILL_QUIT] Application lifecycle will-quit completed.');
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !isQuitting) {
      isQuitting = true;
      app.quit();
    }
  });
}
