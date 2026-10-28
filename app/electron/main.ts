import { app } from 'electron';
import { windowCoordinator } from './domains/windows';
import { shortcutManager } from './domains/shortcuts';
import { ipcRouter } from './domains/ipc-router';

// Prevent multiple instances
const gotSingleInstanceLock = app.requestSingleInstanceLock();
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

    app.on('activate', () => {
      if (!windowCoordinator.getControlWindow()) {
        windowCoordinator.init();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

