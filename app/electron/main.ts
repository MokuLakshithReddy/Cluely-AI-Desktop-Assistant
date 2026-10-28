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

