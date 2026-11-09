import { afterAll, vi } from 'vitest';
import fs from 'node:fs';

const testState = vi.hoisted(() => ({
  userDataPath: `${process.env.TEMP || process.env.TMPDIR || process.cwd()}/cluely-vitest-electron-${process.pid}`,
  windows: [] as any[],
}));

/**
 * Unit tests exercise main-process logic with deterministic Electron boundaries.
 * The real Electron binary is exercised separately by the desktop smoke and
 * packaged-app jobs; importing Electron in Vitest must not download a binary.
 */
vi.mock('electron', () => {
  class MockBrowserWindow {
    static getAllWindows = vi.fn(() => testState.windows);
    static fromWebContents = vi.fn(() => null);
    static fromId = vi.fn(() => null);

    readonly id = testState.windows.length + 1;
    readonly webContents = {
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => 'file:///test/dist/index.html'),
    };
    private destroyed = false;
    private visible = false;
    private minimized = false;
    private bounds = { x: 0, y: 24, width: 490, height: 56 };

    constructor(public readonly options: Record<string, unknown> = {}) {
      testState.windows.push(this);
    }

    on = vi.fn(() => this);
    once = vi.fn(() => this);
    off = vi.fn(() => this);
    removeListener = vi.fn(() => this);
    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);
    show = vi.fn(() => { this.visible = true; });
    showInactive = vi.fn(() => { this.visible = true; });
    hide = vi.fn(() => { this.visible = false; });
    focus = vi.fn();
    close = vi.fn(() => { this.destroyed = true; });
    destroy = vi.fn(() => { this.destroyed = true; });
    isDestroyed = vi.fn(() => this.destroyed);
    isVisible = vi.fn(() => this.visible);
    isMinimized = vi.fn(() => this.minimized);
    minimize = vi.fn(() => { this.minimized = true; });
    restore = vi.fn(() => { this.minimized = false; });
    setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = bounds; });
    getBounds = vi.fn(() => ({ ...this.bounds }));
    setPosition = vi.fn((x: number, y: number) => { this.bounds = { ...this.bounds, x, y }; });
    setSize = vi.fn((width: number, height: number) => { this.bounds = { ...this.bounds, width, height }; });
    setContentProtection = vi.fn();
    setAlwaysOnTop = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setFocusable = vi.fn();
    setMenuBarVisibility = vi.fn();
    getPosition = vi.fn(() => [this.bounds.x, this.bounds.y]);
    getSize = vi.fn(() => [this.bounds.width, this.bounds.height]);
  }

  const app = {
    getPath: vi.fn(() => testState.userDataPath),
    getAppPath: vi.fn(() => process.cwd()),
    getVersion: vi.fn(() => '1.0.2'),
    isReady: vi.fn(() => false),
    isPackaged: false,
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    once: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
    relaunch: vi.fn(),
    focus: vi.fn(),
  };

  const safeStorage = {
    isAsyncEncryptionAvailable: vi.fn(async () => false),
    getSelectedStorageBackend: vi.fn(() => 'basic_text'),
    encryptStringAsync: vi.fn(async () => { throw new Error('OS-backed test storage is unavailable'); }),
    decryptStringAsync: vi.fn(async () => { throw new Error('OS-backed test storage is unavailable'); }),
  };

  const ipcMain = {
    handle: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  };

  const ipcRenderer = {
    invoke: vi.fn(async () => undefined),
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  };

  return {
    app,
    safeStorage,
    ipcMain,
    ipcRenderer,
    BrowserWindow: MockBrowserWindow,
    desktopCapturer: { getSources: vi.fn(async () => []) },
    screen: {
      getPrimaryDisplay: vi.fn(() => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
      getDisplayMatching: vi.fn(() => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
      getAllDisplays: vi.fn(() => []),
      getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    },
    session: {
      defaultSession: {
        setDisplayMediaRequestHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() },
      },
    },
    globalShortcut: {
      register: vi.fn(() => true),
      unregister: vi.fn(),
      unregisterAll: vi.fn(),
      isRegistered: vi.fn(() => false),
    },
    shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
      showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    },
    clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
    nativeTheme: { shouldUseDarkColors: true, themeSource: 'dark', on: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(() => ({})), setApplicationMenu: vi.fn() },
    Tray: class MockTray { on = vi.fn(); setToolTip = vi.fn(); setContextMenu = vi.fn(); destroy = vi.fn(); },
    powerMonitor: { on: vi.fn(), getSystemIdleState: vi.fn(() => 'active') },
    contextBridge: { exposeInMainWorld: vi.fn() },
  };
});

afterAll(() => {
  try {
    fs.rmSync(testState.userDataPath, { recursive: true, force: true });
  } catch {
    // Test-only temporary profile cleanup must not hide test results.
  }
  testState.windows.splice(0);
});
