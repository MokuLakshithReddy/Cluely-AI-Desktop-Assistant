import { describe, it, expect, beforeEach, vi } from 'vitest';

class MockLocalStorage {
  private store: Map<string, string> = new Map();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  get length(): number {
    return this.store.size;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

// Polyfill window, localStorage, and navigator for test environment
if (typeof global.window === 'undefined') {
  (global as any).window = global;
}
(global as any).window.addEventListener = (global as any).window.addEventListener || vi.fn();
(global as any).window.removeEventListener = (global as any).window.removeEventListener || vi.fn();

const mockStorage = new MockLocalStorage();
(global as any).localStorage = mockStorage;
if (typeof (global as any).window.localStorage === 'undefined') {
  (global as any).window.localStorage = mockStorage;
}
if (typeof global.navigator === 'undefined') {
  (global as any).navigator = { mediaDevices: {} };
}

import { initWebBridge } from '../src/lib/web-bridge';

describe('WebBridge Security and Memory Architecture', () => {
  beforeEach(() => {
    mockStorage.clear();
    delete (window as any).desktopBridge;
  });

  it('stores API keys ephemerally in-memory and NEVER persists them to localStorage', async () => {
    const bridge = initWebBridge();

    // Verify initial keys state
    const initialKeys = await bridge.getHasApiKeys();
    expect(initialKeys.gemini).toBe(false);
    expect(initialKeys.openai).toBe(false);

    // Save keys via bridge
    await bridge.saveApiKey('gemini', 'AIzaSyTestGeminiKey123');
    await bridge.saveApiKey('openai', 'sk-testOpenAiKey456');

    // Confirm bridge reports keys present
    const updatedKeys = await bridge.getHasApiKeys();
    expect(updatedKeys.gemini).toBe(true);
    expect(updatedKeys.openai).toBe(true);

    // CRITICAL SECURITY ASSERTION: Ensure no keys were stored in browser localStorage
    expect(mockStorage.getItem('cluely_vault_keys')).toBeNull();
    expect(mockStorage.getItem('cluely_keys')).toBeNull();
    expect(mockStorage.getItem('gemini_key')).toBeNull();
    expect(mockStorage.getItem('openai_key')).toBeNull();

    // Verify localStorage contains zero API key strings
    for (let i = 0; i < mockStorage.length; i++) {
      const key = mockStorage.key(i) || '';
      const val = mockStorage.getItem(key) || '';
      expect(val).not.toContain('AIzaSyTestGeminiKey123');
      expect(val).not.toContain('sk-testOpenAiKey456');
    }

    // Delete one key
    await bridge.deleteApiKey('gemini');
    const afterDeleteKeys = await bridge.getHasApiKeys();
    expect(afterDeleteKeys.gemini).toBe(false);
    expect(afterDeleteKeys.openai).toBe(true);
  });

  it('purgeAllData wipes in-memory vault keys and stored session archives', async () => {
    const bridge = initWebBridge();

    await bridge.saveApiKey('gemini', 'AIzaSyTestKey');
    await bridge.saveApiKey('anthropic', 'sk-ant-test');
    await bridge.saveSessionRecord({
      id: 'sess_test_1',
      title: 'Session to be purged',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationSeconds: 10,
      mode: 'copilot',
      audioInputLanguage: 'en',
      transcript: [],
      messages: [],
    });

    const sessionsBefore = await bridge.listPastSessions();
    expect(sessionsBefore.length).toBe(1);

    // Execute purge
    if (bridge.purgeAllData) {
      await bridge.purgeAllData();
    }

    const sessionsAfter = await bridge.listPastSessions();
    expect(sessionsAfter.length).toBe(0);

    const keysAfter = await bridge.getHasApiKeys();
    expect(keysAfter.gemini).toBe(false);
    expect(keysAfter.anthropic).toBe(false);
  });

  it('rejects screen capture when mediaDevices.getDisplayMedia is rejected and does not fabricate canvas images', async () => {
    const bridge = initWebBridge();

    // Mock getDisplayMedia throwing NotAllowedError (user clicked cancel)
    (navigator as any).mediaDevices = {
      getDisplayMedia: vi.fn().mockRejectedValue(new Error('Permission denied by user')),
    };

    await expect(bridge.captureScreenshot()).rejects.toThrow(
      'Screen capture permission denied or unavailable'
    );
  });

  it('abortAiStream returns false for unknown requestId without aborting other requests', async () => {
    const bridge = initWebBridge();
    const activeReqId = 'req_active_123';

    // Start request
    const streamPromise = bridge.executeAiStream({
      model: 'gemini-3.6-flash',
      mode: 'copilot',
      query: 'Hello world',
      recentTranscript: [],
      requestId: activeReqId,
    });

    // Abort a completely different non-existent request ID
    const abortResult = await bridge.abortAiStream?.('req_non_existent');
    expect(abortResult).toBe(false);

    // Now abort the actual active request
    const legitimateAbort = await bridge.abortAiStream?.(activeReqId);
    expect(legitimateAbort).toBe(true);

    const result = await streamPromise;
    expect(result.content.length).toBeLessThan(400);
  });

  it('exposes window lifecycle controls minimizeApp and quitApp safely', () => {
    const bridge = initWebBridge();
    expect(typeof bridge.minimizeApp).toBe('function');
    expect(typeof bridge.quitApp).toBe('function');

    // Safe execution without crashing
    expect(() => bridge.minimizeApp?.()).not.toThrow();
  });
});
