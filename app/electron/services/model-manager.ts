import http from 'http';
import { HardwareProfile } from './hardware-detector';

export interface CatalogModel {
  name: string;
  tag: string;
  type: 'text' | 'vision' | 'code';
  parameters: string;
  diskSizeGb: number;
  minRamGb: number;
  description: string;
  isRecommended: boolean;
}

export interface InstalledModel {
  name: string;
  tag: string;
  sizeBytes: number;
  modifiedAt: string;
  format?: string;
  family?: string;
  parameterSize?: string;
  quantizationLevel?: string;
}

export class ModelManager {
  private ollamaHost = '127.0.0.1';
  private ollamaPort = 11434;

  public async getStatus(): Promise<{ isRunning: boolean; version?: string; endpoint: string }> {
    const endpoint = `http://${this.ollamaHost}:${this.ollamaPort}`;
    try {
      const data = await this.httpGetJson<{ version: string }>(`${endpoint}/api/version`);
      return { isRunning: true, version: data.version, endpoint };
    } catch {
      return { isRunning: false, endpoint };
    }
  }

  public async listInstalledModels(): Promise<InstalledModel[]> {
    const endpoint = `http://${this.ollamaHost}:${this.ollamaPort}/api/tags`;
    try {
      const res = await this.httpGetJson<{ models: any[] }>(endpoint);
      if (!res?.models || !Array.isArray(res.models)) return [];
      return res.models.map(m => ({
        name: m.name,
        tag: m.model || m.name,
        sizeBytes: m.size || 0,
        modifiedAt: m.modified_at || '',
        format: m.details?.format,
        family: m.details?.family,
        parameterSize: m.details?.parameter_size,
        quantizationLevel: m.details?.quantization_level,
      }));
    } catch {
      return [];
    }
  }

  public getCatalog(hardware: HardwareProfile): CatalogModel[] {
    const totalRamGb = hardware.totalRamMb / 1024;

    const catalog: CatalogModel[] = [
      {
        name: 'Llama 3.2 (1B)',
        tag: 'llama3.2:1b',
        type: 'text',
        parameters: '1.2B',
        diskSizeGb: 1.3,
        minRamGb: 6,
        description: 'Ultra-fast, lightweight general assistant with low memory footprint.',
        isRecommended: totalRamGb < 12,
      },
      {
        name: 'Llama 3.2 (3B)',
        tag: 'llama3.2:3b',
        type: 'text',
        parameters: '3.2B',
        diskSizeGb: 2.0,
        minRamGb: 8,
        description: 'Optimal balance of reasoning, speed, and accuracy for 16GB machines.',
        isRecommended: totalRamGb >= 12,
      },
      {
        name: 'Moondream 2',
        tag: 'moondream',
        type: 'vision',
        parameters: '1.8B',
        diskSizeGb: 1.7,
        minRamGb: 8,
        description: 'Fast local vision model for screen context, charts, and document analysis.',
        isRecommended: totalRamGb < 16,
      },
      {
        name: 'LLaVA (7B)',
        tag: 'llava:7b',
        type: 'vision',
        parameters: '7B',
        diskSizeGb: 4.7,
        minRamGb: 12,
        description: 'High-detail visual reasoning and OCR for desktop capture.',
        isRecommended: totalRamGb >= 14,
      },
      {
        name: 'Qwen 2.5 Coder (1.5B)',
        tag: 'qwen2.5-coder:1.5b',
        type: 'code',
        parameters: '1.5B',
        diskSizeGb: 1.6,
        minRamGb: 6,
        description: 'Specialized programming and code debugging assistant.',
        isRecommended: false,
      },
    ];

    return catalog;
  }

  public pullModel(
    modelName: string,
    onProgress: (status: { status: string; completed?: number; total?: number }) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ name: modelName });
      const req = http.request(
        {
          hostname: this.ollamaHost,
          port: this.ollamaPort,
          path: '/api/pull',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        res => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Ollama pull failed with HTTP status ${res.statusCode}`));
          }

          let buffer = '';
          res.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line);
                onProgress({
                  status: parsed.status || 'Downloading...',
                  completed: parsed.completed,
                  total: parsed.total,
                });
              } catch {
                // Ignore parsing chunk split
              }
            }
          });

          res.on('end', () => resolve());
          res.on('error', err => reject(err));
        }
      );

      const abortHandler = () => {
        req.destroy();
        reject(new Error('Model pull cancelled'));
      };

      signal?.addEventListener('abort', abortHandler);
      req.on('error', err => {
        signal?.removeEventListener('abort', abortHandler);
        reject(err);
      });

      req.write(postData);
      req.end();
    });
  }

  public deleteModel(modelName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ name: modelName });
      const req = http.request(
        {
          hostname: this.ollamaHost,
          port: this.ollamaPort,
          path: '/api/delete',
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        res => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Ollama delete failed with HTTP status ${res.statusCode}`));
          }
        }
      );

      req.on('error', err => reject(err));
      req.write(postData);
      req.end();
    });
  }

  public async testGeneration(modelName = 'llama3.2:1b'): Promise<{ success: boolean; text: string; latencyMs: number; error?: string }> {
    const t0 = Date.now();
    try {
      const postData = JSON.stringify({
        model: modelName,
        prompt: 'Say: "Scandium local AI engine is online and operational."',
        stream: false,
      });

      const res = await new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: this.ollamaHost,
            port: this.ollamaPort,
            path: '/api/generate',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
            },
            timeout: 15000,
          },
          response => {
            let data = '';
            response.on('data', chunk => (data += chunk));
            response.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(e);
              }
            });
          }
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Generation test timed out'));
        });
        req.write(postData);
        req.end();
      });

      const latencyMs = Date.now() - t0;
      return {
        success: true,
        text: res.response?.trim() || 'OK',
        latencyMs,
      };
    } catch (err: any) {
      return {
        success: false,
        text: '',
        latencyMs: Date.now() - t0,
        error: err?.message || String(err),
      };
    }
  }

  private httpGetJson<T>(urlStr: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const req = http.get(
        {
          hostname: parsed.hostname,
          port: parsed.port || 80,
          path: parsed.pathname + parsed.search,
          timeout: 2000,
        },
        res => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data) as T);
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
    });
  }
}

export const modelManager = new ModelManager();
