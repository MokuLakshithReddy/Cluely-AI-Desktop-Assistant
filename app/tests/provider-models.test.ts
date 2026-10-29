import { describe, it, expect, vi, beforeEach } from 'vitest';
import { streamGemini, streamOpenAI, streamClaude, buildContextPrompt } from '../src/lib/providers';

describe('AI Provider Model Propagation and Multi-Turn Serialization', () => {
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

  it('streamGemini defaults to gemini-3.6-flash, routes URL correctly and serializes multi-turn history', async () => {
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
    expect(capturedUrl).toContain('/models/gemini-3.6-flash:streamGenerateContent');
    expect(capturedHeaders['x-goog-api-key']).toBe('AIzaSyGeminiKey2026');

    // Multi-turn contents check (user -> user, assistant -> model)
    expect(capturedBody.contents.length).toBe(3);
    expect(capturedBody.contents[0].role).toBe('user');
    expect(capturedBody.contents[0].parts[0].text).toBe('Earlier question');
    expect(capturedBody.contents[1].role).toBe('model');
    expect(capturedBody.contents[1].parts[0].text).toBe('Earlier answer');
    expect(capturedBody.contents[2].role).toBe('user');
  });

  it('streamGemini provides diagnostic guidance on 403 / 404 model errors', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'models/gemini-2.5-flash is not found' } }), {
        status: 404,
        statusText: 'Not Found',
      })
    );

    await expect(
      streamGemini({
        model: 'gemini-2.5-flash',
        apiKey: 'AIzaSyKey',
        mode: 'copilot',
        query: 'Test',
        recentTranscript: [],
      })
    ).rejects.toThrow(/gemini-2\.5-flash.*Gemini 3\.[68] Flash/i);
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
    expect(capturedBody.messages.length).toBe(4); // system + 2 history + current
    expect(capturedBody.messages[0].role).toBe('system');
    expect(capturedBody.messages[1].role).toBe('user');
    expect(capturedBody.messages[1].content).toBe('Previous snippet');
    expect(capturedBody.messages[2].role).toBe('assistant');
    expect(capturedBody.messages[2].content).toBe('Here is the bug explanation');
    expect(capturedBody.messages[3].role).toBe('user');
  });

  it('streamClaude maps active 2026 models with anthropic-version 2026-10-21 and preserves multi-turn context', async () => {
    let capturedBody: any = null;
    let capturedHeaders: Record<string, string> = {};

    global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = JSON.parse(init.body as string);
      return createMockSseResponse([
        JSON.stringify({
          type: 'content_block_delta',
          delta: { text: 'Claude Sonnet 5.5 response' },
        }),
      ]);
    });

    const result = await streamClaude({
      model: 'claude-sonnet-5-5',
      apiKey: 'sk-ant-claude55',
      mode: 'interview',
      query: 'Solve this dynamic programming problem',
      recentTranscript: [],
      conversationHistory: [
        { role: 'user', content: 'Here is the constraints list' },
        { role: 'assistant', content: 'Got it, O(N log N) space approach' },
      ],
    });

    expect(result).toBe('Claude Sonnet 5.5 response');
    expect(capturedBody.model).toBe('claude-sonnet-5-5');
    expect(capturedHeaders['x-api-key']).toBe('sk-ant-claude55');
    expect(capturedHeaders['anthropic-version']).toBe('2026-10-21');
    expect(capturedBody.messages.length).toBe(3); // 2 history + current
    expect(capturedBody.messages[0].role).toBe('user');
    expect(capturedBody.messages[1].role).toBe('assistant');
    expect(capturedBody.messages[2].role).toBe('user');
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
