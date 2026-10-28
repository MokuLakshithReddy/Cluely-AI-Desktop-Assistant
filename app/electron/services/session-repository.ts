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

  public async saveSession(session: SessionRecord): Promise<void> {
    if (!session || !session.id) throw new Error('Invalid session record');
    const filePath = path.join(this.getStorageDir(), `${session.id}.json`);
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
  }

  public async getSession(id: string): Promise<SessionRecord | null> {
    if (!id) return null;
    const cleanId = path.basename(id);
    const filePath = path.join(this.getStorageDir(), `${cleanId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      console.error(`[SessionRepository] Failed to read session ${cleanId}:`, e);
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
    const cleanId = path.basename(id);
    const filePath = path.join(this.getStorageDir(), `${cleanId}.json`);
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
