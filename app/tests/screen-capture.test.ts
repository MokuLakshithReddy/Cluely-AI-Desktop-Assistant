import { describe, it, expect } from 'vitest';
import { calculateThumbnailSize } from '../electron/domains/screenshot';

describe('Screen Capture & Thumbnail Scaling Subsystem', () => {
  it('passes unscaled bounds when screen resolution <= 1920x1080', () => {
    const fhd = { width: 1920, height: 1080 };
    const res = calculateThumbnailSize(fhd);
    expect(res.width).toBe(1920);
    expect(res.height).toBe(1080);

    const small = { width: 1280, height: 720 };
    const resSmall = calculateThumbnailSize(small);
    expect(resSmall.width).toBe(1280);
    expect(resSmall.height).toBe(720);
  });

  it('scales 4K display (3840x2160) proportionally to 1920x1080 (0.5x ratio)', () => {
    const uhd = { width: 3840, height: 2160 };
    const res = calculateThumbnailSize(uhd);
    expect(res.width).toBe(1920);
    expect(res.height).toBe(1080);
  });

  it('scales ultra-wide display (3440x1440) proportionally capped at 1920', () => {
    const uw = { width: 3440, height: 1440 };
    const res = calculateThumbnailSize(uw);
    expect(res.width).toBe(1920);
    expect(res.height).toBe(Math.round(1440 * (1920 / 3440)));
  });

  it('preserves aspect ratio when height is greater than width (portrait display)', () => {
    const portrait = { width: 1440, height: 2560 };
    const res = calculateThumbnailSize(portrait);
    expect(res.height).toBe(1920);
    expect(res.width).toBe(Math.round(1440 * (1920 / 2560)));
  });

  it('handles boundary 1x1 minimal screen dimension safely', () => {
    const min = { width: 1, height: 1 };
    const res = calculateThumbnailSize(min);
    expect(res.width).toBe(1);
    expect(res.height).toBe(1);
  });
});
