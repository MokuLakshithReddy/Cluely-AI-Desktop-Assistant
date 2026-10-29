import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { windowCoordinator } from './domains/windows';
import { shortcutManager } from './domains/shortcuts';
import { ipcRouter } from './domains/ipc-router';
import { stateManager } from './domains/state';

let isQuitting = false;

// Prevent multiple instances (bypassed in automated smoke test to avoid lock contention with running app)
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
    windowCoordinator.init();
    shortcutManager.init();

    // Signal verified application readiness to parent runners / smoke harness
    console.log('[APP_READY] Cluely Desktop Coordinator Ready');

    if (process.env.SMOKE_TEST === 'true') {
      const shutdownTrigger = path.join(app.getAppPath(), '.smoke-shutdown.trigger');
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

