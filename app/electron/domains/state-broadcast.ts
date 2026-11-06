export interface StateBroadcastWindow {
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, payload: unknown): void;
  };
}

export interface StateBroadcastCoordinator {
  getControlWindow(): StateBroadcastWindow | null;
  getChatWindow(): StateBroadcastWindow | null;
  getDashboardWindow(): StateBroadcastWindow | null;
}

/** Send shared-state snapshots to every live renderer window. */
export function broadcastSharedStateToAppWindows(
  coordinator: StateBroadcastCoordinator,
  state: unknown
): void {
  const windows = [
    coordinator.getControlWindow(),
    coordinator.getChatWindow(),
    coordinator.getDashboardWindow(),
  ];

  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('shared-state-updated', state);
    }
  }
}
