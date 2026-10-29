import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  mode: string;
  audioInputLanguage: string;
  transcript: Array<{
    id: string;
    createdAt: string;
    relativeMs: number;
    role: 'me' | 'them';
    status: 'transcribing' | 'ready' | 'error';
    text: string;
    error?: string;
  }>;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt: string;
    screenshot?: string;
    sources?: string[];
  }>;
  summary?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  mode: string;
  transcriptCount: number;
  messageCount: number;
}

export class SessionRepository {
  private static readonly SESSION_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

  private getStorageDir(): string {
    let base: string;
    try {
      base = app.getPath('userData');
    } catch {
      base = process.cwd();
    }
    const dir = path.join(base, 'sessions');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Validates session ID against strict character set and bounds.
   * Rejects path separators, directory traversal sequences, or oversized identifiers.
   */
  public validateSessionId(id: string): string {
    if (!id || typeof id !== 'string') {
      throw new Error('[SessionRepository] Invalid session ID: ID must be a non-empty string');
    }
    const trimmed = id.trim();
    if (!SessionRepository.SESSION_ID_REGEX.test(trimmed)) {
      throw new Error(`[SessionRepository] Malformed session ID: "${id}". Must match ${SessionRepository.SESSION_ID_REGEX}`);
    }
    if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\') || path.basename(trimmed) !== trimmed) {
      throw new Error(`[SessionRepository] Path traversal detected in session ID: "${id}"`);
    }
    return trimmed;
  }

  /**
   * Resolves destination file path and asserts strict directory boundary containment.
   */
  public resolveSessionPath(id: string): string {
    const cleanId = this.validateSessionId(id);
    const storageDir = path.resolve(this.getStorageDir());
    const targetPath = path.resolve(storageDir, `${cleanId}.json`);

    // Verify target path is strictly inside storageDir
    if (!targetPath.startsWith(storageDir + path.sep)) {
      throw new Error(`[SessionRepository] Security boundary violation: "${targetPath}" is outside "${storageDir}"`);
    }

    return targetPath;
  }

  public async saveSession(session: SessionRecord): Promise<void> {
    if (!session || !session.id) {
      throw new Error('[SessionRepository] Invalid session record: Missing session ID');
    }
    const filePath = this.resolveSessionPath(session.id);
    session.updatedAt = new Date().toISOString();

    // Defense-in-depth: Strip heavy screenshot base64 payloads before writing to disk
    const sanitizedMessages = (session.messages || []).map(msg => {
      if (msg.screenshot) {
        const { screenshot, ...rest } = msg;
        return rest as any;
      }
      return msg;
    });
    const recordToSave = {
      ...session,
      messages: sanitizedMessages,
    };

    const serialized = JSON.stringify(recordToSave, null, 2);
    if (serialized.length > 5 * 1024 * 1024) {
      throw new Error('[SessionRepository] Session exceeds maximum aggregate size limit of 5MB');
    }
    fs.writeFileSync(filePath, serialized, 'utf8');
  }

  public async getSession(id: string): Promise<SessionRecord | null> {
    if (!id) return null;
    let filePath: string;
    try {
      filePath = this.resolveSessionPath(id);
    } catch {
      return null;
    }
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      console.error(`[SessionRepository] Failed to read session ${id}:`, e);
      return null;
    }
  }

  public async listSessions(): Promise<SessionSummary[]> {
    const dir = this.getStorageDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const summaries: SessionSummary[] = [];

    for (const file of files) {
      try {
        const fullPath = path.join(dir, file);
        const raw = fs.readFileSync(fullPath, 'utf8');
        const s: SessionRecord = JSON.parse(raw);
        summaries.push({
          id: s.id,
          title: s.title || `Session ${new Date(s.createdAt).toLocaleDateString()}`,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt || s.createdAt,
          durationSeconds: s.durationSeconds || 0,
          mode: s.mode || 'copilot',
          transcriptCount: s.transcript?.length || 0,
          messageCount: s.messages?.length || 0,
        });
      } catch (e) {
        console.warn(`[SessionRepository] Skipping unreadable file ${file}:`, e);
      }
    }

    // Sort newest first
    summaries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return summaries;
  }

  public async deleteSession(id: string): Promise<boolean> {
    if (!id) return false;
    let filePath: string;
    try {
      filePath = this.resolveSessionPath(id);
    } catch {
      return false;
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  public async purgeAll(): Promise<void> {
    const dir = this.getStorageDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(dir, file));
      } catch {}
    }
  }
}

export const sessionRepository = new SessionRepository();

