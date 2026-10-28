import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionRepository, SessionRecord } from '../electron/services/session-repository';
import fs from 'fs';
import path from 'path';

describe('Multi-Session Archive & Persistence Subsystem', () => {
  let repo: SessionRepository;
  const testDir = path.join(process.cwd(), 'test-sessions');

  beforeEach(() => {
    repo = new SessionRepository();
    (repo as any).getStorageDir = () => {
      if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
      return testDir;
    };
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('saves and reads a full session record with transcripts and messages', async () => {
    const session: SessionRecord = {
      id: 'sess_test_101',
      title: 'Technical Interview with Mock Corp',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationSeconds: 120,
      mode: 'interview',
      audioInputLanguage: 'en',
      transcript: [
        {
          id: 't1',
          createdAt: new Date().toISOString(),
          relativeMs: 5000,
          role: 'them',
          status: 'ready',
          text: 'Explain dynamic programming vs memoization.',
        },
      ],
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Dynamic programming is typically bottom-up with a table.',
          createdAt: new Date().toISOString(),
        },
      ],
    };

    await repo.saveSession(session);
    const loaded = await repo.getSession('sess_test_101');

    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe('sess_test_101');
    expect(loaded?.title).toBe('Technical Interview with Mock Corp');
    expect(loaded?.transcript.length).toBe(1);
    expect(loaded?.messages.length).toBe(1);
  });

  it('lists past sessions ordered by newest creation date', async () => {
    const s1: SessionRecord = {
      id: 'sess_1',
      title: 'Earlier Session',
      createdAt: new Date(Date.now() - 100000).toISOString(),
      updatedAt: new Date().toISOString(),
      durationSeconds: 60,
      mode: 'copilot',
      audioInputLanguage: 'en',
      transcript: [],
      messages: [],
    };
    const s2: SessionRecord = {
      id: 'sess_2',
      title: 'Recent Session',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationSeconds: 180,
      mode: 'coding',
      audioInputLanguage: 'en',
      transcript: [],
      messages: [],
    };

    await repo.saveSession(s1);
    await repo.saveSession(s2);

    const list = await repo.listSessions();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe('sess_2'); // Newest first
    expect(list[1].id).toBe('sess_1');
  });

  it('deletes an individual session by identifier', async () => {
    const s: SessionRecord = {
      id: 'sess_to_delete',
      title: 'Discardable Call',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationSeconds: 30,
      mode: 'sales',
      audioInputLanguage: 'en',
      transcript: [],
      messages: [],
    };

    await repo.saveSession(s);
    expect(await repo.getSession('sess_to_delete')).not.toBeNull();

    const deleted = await repo.deleteSession('sess_to_delete');
    expect(deleted).toBe(true);
    expect(await repo.getSession('sess_to_delete')).toBeNull();
  });

  it('purges all archived sessions cleanly', async () => {
    for (let i = 0; i < 3; i++) {
      await repo.saveSession({
        id: `sess_purge_${i}`,
        title: `Session ${i}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        durationSeconds: 10,
        mode: 'copilot',
        audioInputLanguage: 'en',
        transcript: [],
        messages: [],
      });
    }

    const before = await repo.listSessions();
    expect(before.length).toBe(3);

    await repo.purgeAll();
    const after = await repo.listSessions();
    expect(after.length).toBe(0);
  });

  it('returns null when requesting a nonexistent session id', async () => {
    const nonExistent = await repo.getSession('invalid_id_999');
    expect(nonExistent).toBeNull();
  });

  it('rejects path traversal attempts in session IDs and protects parent directories', async () => {
    const maliciousTraversals = [
      '../../escaped_session',
      '..\\..\\win_escaped',
      '../test',
      'sub/dir/id',
      'valid_id/../../evil',
      'id_with_null\0_byte',
      'invalid space id',
      'sess_with_symbols*?!',
      'a'.repeat(65), // Exceeds 64 char max length
    ];

    for (const badId of maliciousTraversals) {
      const maliciousSession: any = {
        id: badId,
        title: 'Exploit attempt',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        transcript: [],
        messages: [],
      };

      // saveSession must throw on path traversal
      await expect(
        repo.saveSession(maliciousSession),
        `Expected saveSession to throw on malicious ID: "${badId}"`
      ).rejects.toThrow(/(Invalid session ID|Malformed session ID|Path traversal detected)/);

      // getSession and deleteSession should safely reject traversal
      expect(await repo.getSession(badId)).toBeNull();
      expect(await repo.deleteSession(badId)).toBe(false);
    }

    // Verify no files were created outside testDir
    const parentDir = path.dirname(testDir);
    const escapedFile = path.join(parentDir, 'escaped_session.json');
    expect(fs.existsSync(escapedFile)).toBe(false);
  });
});

