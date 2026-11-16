import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import https from 'https';
import { spawn } from 'child_process';
import { app } from 'electron';

export interface WhisperModelInfo {
  id: string;
  name: string;
  filename: string;
  sizeBytes: number;
  url: string;
  sha256?: string;
  isDownloaded: boolean;
}

export const WHISPER_MODELS: Record<string, WhisperModelInfo> = {
  'ggml-tiny.en': {
    id: 'ggml-tiny.en',
    name: 'Whisper Tiny (English, ~75MB)',
    filename: 'ggml-tiny.en.bin',
    sizeBytes: 77705139,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
    sha256: 'bd577a113a864445d4c299885e8ebd97d4ec1e98b15f66e03e0f69b48db29239',
    isDownloaded: false,
  },
  'ggml-base.en': {
    id: 'ggml-base.en',
    name: 'Whisper Base (English, ~142MB)',
    filename: 'ggml-base.en.bin',
    sizeBytes: 147964211,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    sha256: '46514b5d2077e3f88591a27196f7c63c509c0fa91fb0f2496a75a74e0d4c8b82',
    isDownloaded: false,
  },
};

export class WhisperRuntime {
  private modelsDir: string;
  private activeModelId = 'ggml-tiny.en';
  private downloadingModelId: string | null = null;
  private downloadProgress = 0;

  constructor() {
    const baseDir = app?.getPath ? app.getPath('userData') : path.join(process.cwd(), '.scandium');
    this.modelsDir = path.join(baseDir, 'whisper-models');
    try {
      if (!fs.existsSync(this.modelsDir)) {
        fs.mkdirSync(this.modelsDir, { recursive: true });
      }
    } catch (e) {
      console.warn('[WhisperRuntime] Failed to create models directory:', e);
    }
  }

  public getModels(): WhisperModelInfo[] {
    return Object.values(WHISPER_MODELS).map(m => {
      const filePath = path.join(this.modelsDir, m.filename);
      const exists = fs.existsSync(filePath) && fs.statSync(filePath).size > 1000000;
      return { ...m, isDownloaded: exists };
    });
  }

  public getActiveModelId(): string {
    return this.activeModelId;
  }

  public setActiveModel(modelId: string) {
    if (WHISPER_MODELS[modelId]) {
      this.activeModelId = modelId;
    }
  }

  public isModelDownloaded(modelId: string): boolean {
    const info = WHISPER_MODELS[modelId];
    if (!info) return false;
    const filePath = path.join(this.modelsDir, info.filename);
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 1000000;
  }

  public getDownloadStatus() {
    return {
      downloadingModelId: this.downloadingModelId,
      progress: this.downloadProgress,
    };
  }

  public async downloadModel(
    modelId: string,
    onProgress?: (percent: number) => void
  ): Promise<boolean> {
    const info = WHISPER_MODELS[modelId];
    if (!info) throw new Error(`Unknown model ID: ${modelId}`);

    if (this.isModelDownloaded(modelId)) return true;
    if (this.downloadingModelId) throw new Error(`Another model is currently downloading: ${this.downloadingModelId}`);

    this.downloadingModelId = modelId;
    this.downloadProgress = 0;
    const destPath = path.join(this.modelsDir, info.filename);
    const tempPath = destPath + '.download';

    try {
      await this.downloadFile(info.url, tempPath, (downloaded, total) => {
        const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
        this.downloadProgress = percent;
        onProgress?.(percent);
      });

      // Verify file size and rename
      const stats = fs.statSync(tempPath);
      if (stats.size < 1000000) {
        throw new Error('Downloaded model file is suspiciously small or corrupted');
      }

      fs.renameSync(tempPath, destPath);
      this.downloadingModelId = null;
      this.downloadProgress = 100;
      return true;
    } catch (err) {
      this.downloadingModelId = null;
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      throw err;
    }
  }

  private downloadFile(
    urlStr: string,
    destPath: string,
    onProgress: (downloaded: number, total: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const handleRequest = (currentUrl: string) => {
        const parsed = new URL(currentUrl);
        https.get(
          {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers: { 'User-Agent': 'Scandium-Desktop/1.0.2' },
          },
          res => {
            // Follow redirects
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              const redirectUrl = new URL(res.headers.location, currentUrl).href;
              return handleRequest(redirectUrl);
            }

            if (res.statusCode !== 200) {
              file.close();
              return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
            }

            const total = parseInt(res.headers['content-length'] || '0', 10);
            let downloaded = 0;

            res.on('data', chunk => {
              downloaded += chunk.length;
              file.write(chunk);
              onProgress(downloaded, total);
            });

            res.on('end', () => {
              file.end();
              resolve();
            });

            res.on('error', err => {
              file.close();
              reject(err);
            });
          }
        ).on('error', err => {
          file.close();
          reject(err);
        });
      };

      handleRequest(urlStr);
    });
  }

  public async transcribeAudio(
    wavBuffer: ArrayBuffer,
    language = 'en',
    signal?: AbortSignal
  ): Promise<string> {
    const modelInfo = WHISPER_MODELS[this.activeModelId] || WHISPER_MODELS['ggml-tiny.en'];
    const modelPath = path.join(this.modelsDir, modelInfo.filename);

    if (!fs.existsSync(modelPath)) {
      return '[Local Whisper STT: Model not installed. Download speech model in Settings -> Local Hardware & Models]';
    }

    const whisperBinary = this.findWhisperExecutable();
    if (!whisperBinary) {
      return '[Local Whisper STT: Whisper runtime binary not found on system. Place whisper-cli in resources/whisper]';
    }

    // Write temp WAV audio file
    const tempAudioPath = path.join(os.tmpdir(), `scandium_stt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`);
    fs.writeFileSync(tempAudioPath, Buffer.from(wavBuffer));

    return new Promise<string>((resolve, reject) => {
      let isAborted = false;
      const child = spawn(
        whisperBinary,
        [
          '--model', modelPath,
          '-f', tempAudioPath,
          '--language', language,
          '-nt', // no timestamps
          '-otxt', // output text
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      const abortHandler = () => {
        isAborted = true;
        try { child.kill('SIGKILL'); } catch {}
        try { if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath); } catch {}
        reject(new Error('Transcription cancelled'));
      };

      signal?.addEventListener('abort', abortHandler);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', data => {
        stdout += data.toString();
      });

      child.stderr?.on('data', data => {
        stderr += data.toString();
      });

      child.on('close', code => {
        signal?.removeEventListener('abort', abortHandler);
        try { if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath); } catch {}

        if (isAborted) return;

        if (code !== 0) {
          console.warn('[WhisperRuntime] Exit code:', code, stderr);
          // Check if txt file was output by whisper
          const txtPath = tempAudioPath + '.txt';
          if (fs.existsSync(txtPath)) {
            const text = fs.readFileSync(txtPath, 'utf8').trim();
            try { fs.unlinkSync(txtPath); } catch {}
            return resolve(text);
          }
          return resolve('');
        }

        // Clean out metadata from stdout
        const cleaned = stdout
          .replace(/\[\d\d:\d\d:\d\d\.\d\d\d --> \d\d:\d\d:\d\d\.\d\d\d\]/g, '')
          .replace(/whisper_print_timings:[\s\S]*$/, '')
          .trim();

        resolve(cleaned);
      });

      child.on('error', err => {
        signal?.removeEventListener('abort', abortHandler);
        try { if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath); } catch {}
        console.warn('[WhisperRuntime] Failed to spawn whisper-cli:', err);
        resolve('');
      });
    });
  }

  private findWhisperExecutable(): string | null {
    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'whisper-cli.exe' : 'whisper-cli';

    // 1. Explicit environment variable
    if (process.env.WHISPER_CLI_PATH && fs.existsSync(process.env.WHISPER_CLI_PATH)) {
      return process.env.WHISPER_CLI_PATH;
    }

    // 2. Packaged / app resources directory
    const candidates = [
      path.join(process.cwd(), 'resources', 'whisper', binaryName),
      path.join(process.cwd(), 'app', 'resources', 'whisper', binaryName),
      path.join(this.modelsDir, binaryName),
      path.join(os.homedir(), '.scandium', 'bin', binaryName),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    return null;
  }
}

export const whisperRuntime = new WhisperRuntime();
