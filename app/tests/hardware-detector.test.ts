import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HardwareDetector,
  isVirtualDisplayAdapter,
  selectPrimaryGpu,
} from '../electron/services/hardware-detector';
import os from 'os';

describe('Hardware Compatibility Subsystem & Model Recommendation', () => {
  let detector: HardwareDetector;

  beforeEach(() => {
    detector = new HardwareDetector();
  });

  it('detects system hardware profile and provides valid defaults', async () => {
    const profile = await detector.getProfile();

    expect(profile).toBeDefined();
    expect(typeof profile.os).toBe('string');
    expect(profile.platform).toBe(os.platform());
    expect(profile.arch).toBe(os.arch());
    expect(profile.cpuCores).toBeGreaterThan(0);
    expect(profile.totalRamMb).toBeGreaterThan(0);
    expect(profile.availableRamMb).toBeGreaterThan(0);
    expect(profile.totalDiskMb).toBeGreaterThan(0);
    expect(Array.isArray(profile.gpus)).toBe(true);
    expect(profile.primaryGpu).toBeDefined();
    expect(typeof profile.recommendedTextModel).toBe('string');
    expect(typeof profile.recommendedVisionModel).toBe('string');
    expect(typeof profile.recommendedSttModel).toBe('string');
    expect(Array.isArray(profile.warnings)).toBe(true);
  });

  it('caches the hardware profile within TTL and dynamic RAM updates', async () => {
    const first = await detector.getProfile();
    const second = await detector.getProfile(false);

    expect(second.cpuModel).toBe(first.cpuModel);
    expect(second.totalRamMb).toBe(first.totalRamMb);
    expect(second.platform).toBe(first.platform);
  });

  it('recommends tier-appropriate models for 16GB+ baseline hardware with healthy free RAM', async () => {
    const customDetector = new HardwareDetector();
    vi.spyOn(os, 'totalmem').mockReturnValue(16 * 1024 * 1024 * 1024); // 16 GB
    vi.spyOn(os, 'freemem').mockReturnValue(8 * 1024 * 1024 * 1024); // 8 GB free

    const profile = await customDetector.getProfile(true);
    expect(profile.recommendedTextModel).toBe('llama3.2:3b');
    expect(profile.recommendedVisionModel).toBe('llava:7b');
    expect(profile.recommendedSttModel).toBe('ggml-base.en');
    expect(profile.warnings).toHaveLength(0);

    vi.restoreAllMocks();
  });

  it('falls back to 1B model when available free RAM is constrained despite 16GB total RAM', async () => {
    const customDetector = new HardwareDetector();
    vi.spyOn(os, 'totalmem').mockReturnValue(16 * 1024 * 1024 * 1024); // 16 GB total
    vi.spyOn(os, 'freemem').mockReturnValue(2 * 1024 * 1024 * 1024); // 2 GB free

    const profile = await customDetector.getProfile(true);
    expect(profile.recommendedTextModel).toBe('llama3.2:1b');
    expect(profile.warnings.some(w => w.includes('Low Available Memory'))).toBe(true);

    vi.restoreAllMocks();
  });

  it('recommends lightweight 1B models and warns when RAM is constrained (<8GB)', async () => {
    const customDetector = new HardwareDetector();
    vi.spyOn(os, 'totalmem').mockReturnValue(4 * 1024 * 1024 * 1024); // 4 GB
    vi.spyOn(os, 'freemem').mockReturnValue(1 * 1024 * 1024 * 1024);

    const profile = await customDetector.getProfile(true);
    expect(profile.recommendedTextModel).toBe('qwen2.5:0.5b');
    expect(profile.warnings.some(w => w.includes('Low System RAM'))).toBe(true);

    vi.restoreAllMocks();
  });

  it('classifies GPU vendors accurately', () => {
    const fn = (detector as any).classifyVendor.bind(detector);
    expect(fn('NVIDIA GeForce RTX 4080')).toBe('nvidia');
    expect(fn('Intel(R) Arc(TM) 140V GPU (8GB)')).toBe('intel');
    expect(fn('Intel(R) Iris(R) Xe Graphics')).toBe('intel');
    expect(fn('Apple M3 Pro Max')).toBe('apple');
    expect(fn('AMD Radeon RX 7900 XTX')).toBe('amd');
    expect(fn('Microsoft Basic Render Driver')).toBe('unknown');
  });

  it('prefers physical GPUs over virtual display adapters such as Parsec or RDP', () => {
    expect(isVirtualDisplayAdapter('Parsec Virtual Display Adapter')).toBe(true);
    expect(isVirtualDisplayAdapter('Microsoft Basic Render Driver')).toBe(true);
    expect(isVirtualDisplayAdapter('Intel(R) Arc(TM) 140V GPU (8GB)')).toBe(false);

    const primary = selectPrimaryGpu([
      { name: 'Parsec Virtual Display Adapter', vendor: 'unknown' },
      { name: 'Intel(R) Arc(TM) 140V GPU (8GB)', vendor: 'intel', vramMb: 2048 },
    ]);
    expect(primary.name).toBe('Intel(R) Arc(TM) 140V GPU (8GB)');
    expect(primary.vendor).toBe('intel');

    const discretePrimary = selectPrimaryGpu([
      { name: 'Intel(R) UHD Graphics', vendor: 'intel', vramMb: 1024 },
      { name: 'NVIDIA GeForce RTX 4070', vendor: 'nvidia', vramMb: 12288 },
    ]);
    expect(discretePrimary.name).toBe('NVIDIA GeForce RTX 4070');

    expect(selectPrimaryGpu([]).name).toBe('Generic / Software Display');
  });
});
