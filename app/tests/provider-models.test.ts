import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  streamGemini,
  streamOpenAI,
  streamClaude,
  streamOllama,
  transcribeAudio,
  buildContextPrompt,
  ANTHROPIC_API_VERSION,
} from '../src/lib/providers';
import {
  MODEL_REGISTRY,
  resolveProviderForModel,
  assertModelCompatibleWithProvider,
  isRegisteredModel,
} from '../src/lib/model-registry';

describe('AI Provider Model Propagation and Multi-Turn Serialization (Mocked HTTP)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function createMockSseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  it('maintains a centralized model registry with distinct API IDs and display names for every advertised model', () => {
    const seenIds = new Set<string>();
    expect(MODEL_REGISTRY.length).toBeGreaterThanOrEqual(10);

    for (const entry of MODEL_REGISTRY) {
      expect(entry.id).toBeTruthy();
      expect(entry.displayName).toBeTruthy();
      expect(entry.displayName).not.toBe(entry.id);
      expect(seenIds.has(entry.id)).toBe(false);
      seenIds.add(entry.id);
      expect(isRegisteredModel(entry.id)).toBe(true);
      expect(resolveProviderForModel(entry.id)).toBe(entry.provider);
      expect(assertModelCompatibleWithProvider(entry.id, entry.provider)).toBe(entry.id);
    }
  });

  it('propagates every configured cloud and local model ID from MODEL_REGISTRY accurately to its provider adapter', async () => {
    for (const entry of MODEL_REGISTRY) {
      let capturedUrl = '';
      let capturedBody: any = null;

      if (entry.provider === 'gemini') {
        global.fetch = vi.fn().mockImplementation(async (url: string) => {
          capturedUrl = url;
          return createMockSseResponse([
            JSON.stringify({ candidates: [{ content: { parts: [{ text: `OK:${entry.id}` }] } }] }),
          ]);
        });
        const out = await streamGemini({
          model: entry.id,
          apiKey: 'AIzaSyRegistryTestKey1234567890123456',
          mode: 'copilot',
          query: 'Ping',
          recentTranscript: [],
        });
        expect(out).toBe(`OK:${entry.id}`);
        expect(capturedUrl).toContain(`/models/${encodeURIComponent(entry.id)}:streamGenerateContent`);
      } else if (entry.provider === 'openai') {
        global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
          capturedBody = JSON.parse(init.body as string);
          return createMockSseResponse([
            JSON.stringify({ choices: [{ delta: { content: `OK:${entry.id}` } }] }),
          ]);
        });
        const out = await streamOpenAI({
          model: entry.id,
          apiKey: 'sk-proj-registryTestKey1234567890',
          mode: 'copilot',
          query: 'Ping',
          recentTranscript: [],
        });
        expect(out).toBe(`OK:${entry.id}`);
        expect(capturedBody.model).toBe(entry.id);
      } else if (entry.provider === 'anthropic') {
        global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
          capturedBody = JSON.parse(init.body as string);
          return createMockSseResponse([
            JSON.stringify({ type: 'content_block_delta', delta: { text: `OK:${entry.id}` } }),
          ]);
        });
        const out = await streamClaude({
          model: entry.id,
          apiKey: 'sk-ant-registryTestKey1234567890',
          mode: 'copilot',
          query: 'Ping',
          recentTranscript: [],
        });
        expect(out).toBe(`OK:${entry.id}`);
        expect(capturedBody.model).toBe(entry.id);
      } else if (entry.provider === 'ollama') {
        const encoder = new TextEncoder();
        global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
          capturedBody = JSON.parse(init.body as string);
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(JSON.stringify({ response: 'OK:ollama' }) + '\n'));
                controller.close();
              },
            }),
            { status: 200 }
          );
        });
        const out = await streamOllama({
          model: entry.id,
          mode: 'copilot',
          query: 'Ping',
          recentTranscript: [],
        });
        expect(out).toBe('OK:ollama');
        expect(capturedBody.model).toBe('llama3.2');
      }
    }
  });

  it('rejects incompatible cross-provider model IDs before touching the network', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    await expect(
      streamClaude({ model: 'gpt-4o', apiKey: 'sk-ant-test', mode: 'copilot', query: 'Hi', recentTranscript: [] })
    ).rejects.toThrow(/not compatible with provider "anthropic"/i);

    await expect(
      streamOpenAI({ model: 'claude-sonnet-5-5', apiKey: 'sk-test', mode: 'copilot', query: 'Hi', recentTranscript: [] })
    ).rejects.toThrow(/not compatible with provider "openai"/i);

    await expect(
      streamGemini({ model: 'gpt-4o-mini', apiKey: 'AIzaSyTest', mode: 'copilot', query: 'Hi', recentTranscript: [] })
    ).rejects.toThrow(/not compatible with provider "gemini"/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('streamGemini routes URL correctly and serializes multi-turn history', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    global.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = JSON.parse(init.body as string);
      return createMockSseResponse([
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Gemini 3.6 Flash response' }] } }],
        }),
      ]);
    });

    const result = await streamGemini({
      model: 'gemini-3.6-flash',
      apiKey: 'AIzaSyGeminiKey2026',
      mode: 'copilot',
      query: 'What is our next step?',
      recentTranscript: [],
      conversationHistory: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
      ],
    });

    expect(result).toBe('Gemini 3.6 Flash response');
    expect(capturedUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse'
    );
    expect(capturedHeaders['x-goog-api-key']).toBe('AIzaSyGeminiKey2026');
    // Deprecated sampling parameters must be omitted for Gemini 3.x / Gemini 4 v1beta compatibility
    expect(capturedBody.generationConfig).toEqual({ maxOutputTokens: 1024 });
    expect(capturedBody.contents.length).toBe(3);
    expect(capturedBody.contents[0].role).toBe('user');
    expect(capturedBody.contents[1].role).toBe('model');
    expect(capturedBody.contents[2].role).toBe('user');
  });

  it('streamGemini provides diagnostic guidance on 403 / 404 model errors without retrying a different model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'models/gemini-2.5-flash is not found' } }), {
        status: 404,
        statusText: 'Not Found',
      })
    );
    global.fetch = fetchMock;

    await expect(
      streamGemini({
        model: 'gemini-2.5-flash',
        apiKey: 'AIzaSyKey',
        mode: 'copilot',
        query: 'Test',
        recentTranscript: [],
      })
    ).rejects.toThrow(/gemini-2\.5-flash.*Gemini 3\.5 Flash-Lite/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams with Gemini 3.1 Pro Preview and does not silently fall back on 403', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'permission denied for requested model' } }), {
        status: 403,
        statusText: 'Forbidden',
      })
    );
    global.fetch = fetchMock;

    await expect(streamGemini({
      model: 'gemini-3.1-pro-preview',
      apiKey: 'AIzaSyKey',
      mode: 'copilot',
      query: 'Test',
      recentTranscript: [],
    })).rejects.toThrow(/Gemini API error/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/models/gemini-3.1-pro-preview:streamGenerateContent');
  });

  it('streamOpenAI dynamically forwards gpt-4o-mini and serializes multi-turn turns', async () => {
    let capturedBody: any = null;

    global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return createMockSseResponse([
        JSON.stringify({
          choices: [{ delta: { content: 'GPT response' } }],
        }),
      ]);
    });

    const result = await streamOpenAI({
      model: 'gpt-4o-mini',
      apiKey: 'sk-openai-mini-key',
      mode: 'coding',
      query: 'Refactor this algorithm',
      recentTranscript: [],
      conversationHistory: [
        { role: 'user', content: 'Previous snippet' },
        { role: 'assistant', content: 'Here is the bug explanation' },
      ],
    });

    expect(result).toBe('GPT response');
    expect(capturedBody.model).toBe('gpt-4o-mini');
    expect(capturedBody.messages.length).toBe(4);
    expect(capturedBody.messages[0].role).toBe('system');
    expect(capturedBody.messages[1].role).toBe('user');
    expect(capturedBody.messages[2].role).toBe('assistant');
    expect(capturedBody.messages[3].role).toBe('user');
  });

  it('streamClaude uses official anthropic-version header and preserves exact Claude 5.5 model IDs', async () => {
    const models = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-fable-5-2'] as const;

    for (const selectedModel of models) {
      let capturedBody: any = null;
      let capturedHeaders: Record<string, string> = {};

      global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedHeaders = init.headers as Record<string, string>;
        capturedBody = JSON.parse(init.body as string);
        return createMockSseResponse([
          JSON.stringify({
            type: 'content_block_delta',
            delta: { text: `Response from ${selectedModel}` },
          }),
        ]);
      });

      const result = await streamClaude({
        model: selectedModel,
        apiKey: 'sk-ant-claude55',
        mode: 'copilot',
        query: 'Verify exact model propagation',
        recentTranscript: [],
      });

      expect(result).toBe(`Response from ${selectedModel}`);
      expect(capturedBody.model).toBe(selectedModel);
      expect(capturedHeaders['x-api-key']).toBe('sk-ant-claude55');
      expect(capturedHeaders['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    }
  });

  it('streamClaude provides diagnostic error when Claude returns model_not_found error', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'not_found_error', message: 'model retired' } }), {
        status: 404,
        statusText: 'Not Found',
      })
    );

    await expect(
      streamClaude({
        model: 'claude-3-7-sonnet' as any,
        apiKey: 'sk-ant-test',
        mode: 'copilot',
        query: 'Test',
        recentTranscript: [],
      })
    ).rejects.toThrow(/retired or unavailable/i);
  });

  it('handles 401 auth errors, 429 rate limits, and 503 outages cleanly WITHOUT leaking API keys', async () => {
    const secretKey = 'sk-proj-SUPERSECRETKEY1234567890ABCDEF';

    // 401 echoing API key in body
    global.fetch = vi.fn().mockResolvedValue(
      new Response(`Unauthorized: invalid credential ${secretKey}`, { status: 401 })
    );
    await expect(
      streamOpenAI({ model: 'gpt-4o', apiKey: secretKey, mode: 'copilot', query: 'Hi', recentTranscript: [] })
    ).rejects.toSatisfy((err: Error) => {
      expect(err.message).toMatch(/authentication error \(401\)/i);
      expect(err.message).not.toContain(secretKey);
      expect(err.message).toContain('[REDACTED_API_KEY]');
      return true;
    });

    // 429 rate limit
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429 })
    );
    await expect(
      streamClaude({ model: 'claude-sonnet-5-5', apiKey: 'sk-ant-secret999', mode: 'copilot', query: 'Hi', recentTranscript: [] })
    ).rejects.toThrow(/rate limit exceeded \(429\)/i);

    // 503 outage
    global.fetch = vi.fn().mockResolvedValue(
      new Response('Service Unavailable', { status: 503 })
    );
    await expect(
      streamGemini({ model: 'gemini-3.6-flash', apiKey: 'AIzaSySecret1234567890123456789012345', mode: 'copilot', query: 'Hi', recentTranscript: [] })
    ).rejects.toThrow(/service outage \(503\)/i);
  });

  it('handles non-streaming JSON responses and surfaces mid-stream SSE errors and malformed JSON', async () => {
    // Non-streaming JSON response (Anthropic)
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'Non-streaming Claude answer' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const jsonRes = await streamClaude({
      model: 'claude-sonnet-5-5',
      apiKey: 'sk-ant-test',
      mode: 'copilot',
      query: 'Hi',
      recentTranscript: [],
    });
    expect(jsonRes).toBe('Non-streaming Claude answer');

    // Mid-stream Anthropic SSE error event
    global.fetch = vi.fn().mockResolvedValue(
      createMockSseResponse([
        JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
      ])
    );
    await expect(
      streamClaude({ model: 'claude-sonnet-5-5', apiKey: 'sk-ant-test', mode: 'copilot', query: 'Hi', recentTranscript: [] })
    ).rejects.toThrow(/stream error.*Overloaded/i);

    // Malformed SSE JSON payload
    global.fetch = vi.fn().mockResolvedValue(createMockSseResponse(['{not-valid-json']));
    await expect(
      streamOpenAI({ model: 'gpt-4o', apiKey: 'sk-test', mode: 'copilot', query: 'Hi', recentTranscript: [] })
    ).rejects.toThrow(/malformed JSON/i);
  });

  it('enforces bounded request timeouts and caller AbortSignal cancellation', async () => {
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    // Timeout
    await expect(
      streamOpenAI({
        model: 'gpt-4o',
        apiKey: 'sk-test',
        mode: 'copilot',
        query: 'Hi',
        recentTranscript: [],
        timeoutMs: 30,
      })
    ).rejects.toThrow(/timed out after 30ms/i);

    // Caller abort
    const controller = new AbortController();
    const p = streamGemini({
      model: 'gemini-3.5-flash-lite',
      apiKey: 'AIzaSyTest',
      mode: 'copilot',
      query: 'Hi',
      recentTranscript: [],
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 15);
    await expect(p).rejects.toThrow(/aborted/i);
  });

  it('rejects missing credentials without calling fetch and validates STT responses safely', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    await expect(
      streamGemini({ model: 'gemini-3.5-flash-lite', apiKey: '', mode: 'copilot', query: 'Hi', recentTranscript: [] })
    ).rejects.toThrow(/Gemini API key is required/i);
    await expect(
      streamOpenAI({ model: 'gpt-4o', apiKey: '   ', mode: 'copilot', query: 'Hi', recentTranscript: [] })
    ).rejects.toThrow(/OpenAI API key is required/i);
    await expect(
      streamClaude({ model: 'claude-sonnet-5-5', apiKey: '', mode: 'copilot', query: 'Hi', recentTranscript: [] })
    ).rejects.toThrow(/Anthropic API key is required/i);
    await expect(
      transcribeAudio(new ArrayBuffer(64), '', 'groq')
    ).rejects.toThrow(/GROQ API key is required/i);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Malformed STT JSON response
    global.fetch = vi.fn().mockResolvedValue(new Response('not-json', { status: 200 }));
    await expect(transcribeAudio(new ArrayBuffer(64), 'gsk_secret_token_1234', 'groq')).rejects.toThrow(/malformed JSON/i);

    // STT 401 error never leaks Groq key
    const groqKey = 'gsk_supersecretkey987654321';
    global.fetch = vi.fn().mockResolvedValue(new Response(`bad key ${groqKey}`, { status: 401 }));
    await expect(transcribeAudio(new ArrayBuffer(64), groqKey, 'groq')).rejects.toSatisfy((err: Error) => {
      expect(err.message).toMatch(/authentication error \(401\)/i);
      expect(err.message).not.toContain(groqKey);
      return true;
    });
  });

  it('buildContextPrompt excludes transcribing and error items from transcript context', () => {
    const prompt = buildContextPrompt(
      'copilot',
      'What should I say?',
      [
        { id: '1', role: 'them', text: 'Where are we?', status: 'ready', relativeMs: 100, createdAt: '' },
        { id: '2', role: 'them', text: '...', status: 'transcribing', relativeMs: 200, createdAt: '' },
        { id: '3', role: 'me', text: 'Error occurred', status: 'error', relativeMs: 300, createdAt: '' },
        { id: '4', role: 'me', text: 'I am explaining the architecture', status: 'ready', relativeMs: 400, createdAt: '' },
      ],
      []
    );

    expect(prompt).toContain('[Remote Speaker]: Where are we?');
    expect(prompt).toContain('[You]: I am explaining the architecture');
    expect(prompt).not.toContain('...');
    expect(prompt).not.toContain('Error occurred');
  });
});
