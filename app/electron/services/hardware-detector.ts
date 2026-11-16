import os from 'os';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GpuInfo {
  name: string;
  driverVersion?: string;
  vramMb?: number;
  vendor: 'nvidia' | 'intel' | 'apple' | 'amd' | 'unknown';
}

export interface HardwareProfile {
  os: string;
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalRamMb: number;
  availableRamMb: number;
  totalDiskMb: number;
  freeDiskMb: number;
  gpus: GpuInfo[];
  primaryGpu: GpuInfo;
  isNvidiaCuda: boolean;
  isAppleSilicon: boolean;
  isIntelArc: boolean;
  recommendedTextModel: string;
  recommendedVisionModel: string;
  recommendedSttModel: string;
  warnings: string[];
}

export class HardwareDetector {
  private cachedProfile: HardwareProfile | null = null;
  private lastChecked = 0;
  private readonly CACHE_TTL_MS = 60000; // 1 minute

  public async getProfile(forceRefresh = false): Promise<HardwareProfile> {
    if (!forceRefresh && this.cachedProfile && Date.now() - this.lastChecked < this.CACHE_TTL_MS) {
      // Refresh dynamic free RAM and free disk without full probe
      return {
        ...this.cachedProfile,
        availableRamMb: Math.round(os.freemem() / (1024 * 1024)),
      };
    }

    const platform = os.platform();
    const arch = os.arch();
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown CPU';
    const cpuCores = cpus.length;
    const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));
    const availableRamMb = Math.round(os.freemem() / (1024 * 1024));

    const { totalDiskMb, freeDiskMb } = this.getDiskSpace();
    const gpus = await this.detectGpus(platform);
    const primaryGpu = gpus.length > 0 ? gpus[0] : { name: 'Generic / Software Display', vendor: 'unknown' as const };

    const isNvidiaCuda = gpus.some(g => g.vendor === 'nvidia');
    const isAppleSilicon = platform === 'darwin' && (arch === 'arm64' || cpuModel.toLowerCase().includes('apple'));
    const isIntelArc = gpus.some(g => g.vendor === 'intel' && g.name.toLowerCase().includes('arc'));

    const warnings: string[] = [];
    if (totalRamMb < 7500) {
      warnings.push('Low System RAM: Less than 8 GB total RAM. Local LLM models may be slow or page to disk.');
    }
    if (freeDiskMb < 5000) {
      warnings.push('Low Free Disk Space: Less than 5 GB available. Model downloads are restricted.');
    }
    if (availableRamMb < 3000) {
      warnings.push(`Low Available Memory: Only ${availableRamMb} MB RAM currently free. Close heavy applications before loading large models.`);
    }

    // Hardware-aware model selection considering both total capacity and available free RAM
    let recommendedTextModel = 'llama3.2:1b';
    let recommendedVisionModel = 'moondream';
    let recommendedSttModel = 'ggml-tiny.en';

    if (totalRamMb >= 14000 && availableRamMb >= 4000) {
      // 16 GB+ Baseline with healthy available headroom (e.g. Intel Arc 140V or M-Series / 16GB PC)
      recommendedTextModel = 'llama3.2:3b';
      recommendedVisionModel = 'llava:7b';
      recommendedSttModel = 'ggml-base.en';
    } else if (totalRamMb >= 7500 || (totalRamMb >= 14000 && availableRamMb < 4000)) {
      // 8 GB - 12 GB, or 16GB system with heavily consumed memory
      recommendedTextModel = 'llama3.2:1b';
      recommendedVisionModel = 'moondream';
      recommendedSttModel = 'ggml-tiny.en';
    } else {
      // Constrained RAM (< 8 GB total)
      recommendedTextModel = 'qwen2.5:0.5b';
      recommendedVisionModel = 'moondream';
      recommendedSttModel = 'ggml-tiny.en';
    }

    const profile: HardwareProfile = {
      os: `${os.type()} ${os.release()}`,
      platform,
      arch,
      cpuModel,
      cpuCores,
      totalRamMb,
      availableRamMb,
      totalDiskMb,
      freeDiskMb,
      gpus,
      primaryGpu,
      isNvidiaCuda,
      isAppleSilicon,
      isIntelArc,
      recommendedTextModel,
      recommendedVisionModel,
      recommendedSttModel,
      warnings,
    };

    this.cachedProfile = profile;
    this.lastChecked = Date.now();
    return profile;
  }

  private getDiskSpace(): { totalDiskMb: number; freeDiskMb: number } {
    try {
      const checkPath = process.cwd();
      const stats = fs.statfsSync(checkPath);
      const totalDiskMb = Math.round((stats.blocks * stats.bsize) / (1024 * 1024));
      const freeDiskMb = Math.round((stats.bfree * stats.bsize) / (1024 * 1024));
      return { totalDiskMb, freeDiskMb };
    } catch {
      return { totalDiskMb: 500000, freeDiskMb: 100000 };
    }
  }

  private async detectGpus(platform: NodeJS.Platform): Promise<GpuInfo[]> {
    const list: GpuInfo[] = [];

    if (platform === 'win32') {
      try {
        const { stdout } = await execAsync(
          'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterRAM | ConvertTo-Json"',
          { timeout: 3000 }
        );
        const parsed = JSON.parse(stdout.trim());
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (!item?.Name) continue;
          const name = String(item.Name);
          const vramMb = item.AdapterRAM ? Math.round(Number(item.AdapterRAM) / (1024 * 1024)) : undefined;
          const vendor = this.classifyVendor(name);
          list.push({ name, driverVersion: item.DriverVersion, vramMb, vendor });
        }
      } catch {
        // Fallback or virtual display
      }
    } else if (platform === 'darwin') {
      try {
        const { stdout } = await execAsync('system_profiler SPDisplaysDataType -json', { timeout: 3000 });
        const parsed = JSON.parse(stdout);
        const spDisplays = parsed.SPDisplaysDataType || [];
        for (const item of spDisplays) {
          const name = item._name || item.sppci_model || 'Apple GPU';
          const vendor = this.classifyVendor(name);
          list.push({ name, vendor });
        }
      } catch {
        list.push({ name: 'Apple Integrated GPU', vendor: 'apple' });
      }
    } else {
      // Linux
      try {
        const { stdout } = await execAsync('lspci | grep -i "vga\\|3d\\|display"', { timeout: 3000 });
        const lines = stdout.split('\n').filter(Boolean);
        for (const line of lines) {
          const name = line.replace(/^[0-9a-f:.]+\s+/, '').trim();
          list.push({ name, vendor: this.classifyVendor(name) });
        }
      } catch {
        // Fallback
      }
    }

    if (list.length === 0) {
      list.push({ name: 'Standard Display Adapter', vendor: 'unknown' });
    }

    return list;
  }

  private classifyVendor(name: string): GpuInfo['vendor'] {
    const lower = name.toLowerCase();
    if (lower.includes('nvidia') || lower.includes('geforce') || lower.includes('quadro') || lower.includes('rtx')) {
      return 'nvidia';
    }
    if (lower.includes('intel') || lower.includes('arc') || lower.includes('iris') || lower.includes('uhd')) {
      return 'intel';
    }
    if (lower.includes('apple') || lower.includes('m1') || lower.includes('m2') || lower.includes('m3') || lower.includes('m4')) {
      return 'apple';
    }
    if (lower.includes('amd') || lower.includes('radeon')) {
      return 'amd';
    }
    return 'unknown';
  }
}

export const hardwareDetector = new HardwareDetector();
