import { desktopCapturer, screen, BrowserWindow } from 'electron';

export interface ScreenshotResult {
  data: string; // Base64 PNG string
  contentType: 'image/png';
  width: number;
  height: number;
}

const MAX_DIMENSION = 1920;

/**
 * Calculates proportionally scaled dimensions capping the max dimension at 1920
 */
export function calculateThumbnailSize(bounds: { width: number; height: number }): { width: number; height: number } {
  const maxSide = Math.max(bounds.width, bounds.height);
  if (maxSide <= MAX_DIMENSION) {
    return { width: bounds.width, height: bounds.height };
  }
  const ratio = MAX_DIMENSION / maxSide;
  return {
    width: Math.round(bounds.width * ratio),
    height: Math.round(bounds.height * ratio),
  };
}

export class ScreenshotService {
  private isCapturing = false;

  /**
   * Captures the display that currently contains the focused or floating window
   */
  public async captureScreen(targetWindow?: BrowserWindow | null): Promise<ScreenshotResult> {
    if (this.isCapturing) {
      throw new Error('Screenshot capture is already in progress');
    }

    this.isCapturing = true;
    try {
      // Find the matching display or fall back to primary
      let targetDisplay = screen.getPrimaryDisplay();
      if (targetWindow && !targetWindow.isDestroyed()) {
        const bounds = targetWindow.getBounds();
        targetDisplay = screen.getDisplayMatching(bounds);
      }

      const thumbnailSize = calculateThumbnailSize(targetDisplay.bounds);

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize,
      });

      if (!sources || sources.length === 0) {
        throw new Error('No screen sources found by desktopCapturer');
      }

      // Match source by display ID, or take the first source
      const matchedSource =
        sources.find(s => s.display_id === targetDisplay.id.toString()) || sources[0];

      if (!matchedSource || matchedSource.thumbnail.isEmpty()) {
        throw new Error('Captured screen thumbnail is empty or unavailable');
      }

      const pngBuffer = matchedSource.thumbnail.toPNG();
      const base64Data = pngBuffer.toString('base64');

      return {
        data: base64Data,
        contentType: 'image/png',
        width: thumbnailSize.width,
        height: thumbnailSize.height,
      };
    } finally {
      this.isCapturing = false;
    }
  }
}

export const screenshotService = new ScreenshotService();

