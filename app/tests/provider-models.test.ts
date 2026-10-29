import { describe, it, expect, vi, beforeEach } from 'vitest';
import { streamGemini, streamOpenAI, streamClaude } from '../src/lib/providers';

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

  it('streamGemini dynamically routes to configured Gemini 2.5 model and includes multi-turn history', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    global.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = JSON.parse(init.body as string);
      return createMockSseResponse([
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Gemini 2.5 response' }] } }],
        }),
      ]);
    });

    const result = await streamGemini({
      model: 'gemini-2.5-pro',
      apiKey: 'AIzaSyGeminiKey2026',
      mode: 'copilot',
      query: 'What is our next step?',
      recentTranscript: [],
      conversationHistory: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
      ],
    });

    expect(result).toBe('Gemini 2.5 response');
    expect(capturedUrl).toContain('/models/gemini-2.5-pro:streamGenerateContent');
    expect(capturedHeaders['x-goog-api-key']).toBe('AIzaSyGeminiKey2026');

    // Multi-turn contents check (user -> user, assistant -> model)
    expect(capturedBody.contents.length).toBe(3);
    expect(capturedBody.contents[0].role).toBe('user');
    expect(capturedBody.contents[0].parts[0].text).toBe('Earlier question');
    expect(capturedBody.contents[1].role).toBe('model');
    expect(capturedBody.contents[1].parts[0].text).toBe('Earlier answer');
    expect(capturedBody.contents[2].role).toBe('user');
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

  it('streamClaude maps claude-3-7-sonnet to 2026 model ID and preserves multi-turn context', async () => {
    let capturedBody: any = null;
    let capturedHeaders: Record<string, string> = {};

    global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = JSON.parse(init.body as string);
      return createMockSseResponse([
        JSON.stringify({
          type: 'content_block_delta',
          delta: { text: 'Claude 3.7 response' },
        }),
      ]);
    });

    const result = await streamClaude({
      model: 'claude-3-7-sonnet',
      apiKey: 'sk-ant-claude37',
      mode: 'interview',
      query: 'Solve this dynamic programming problem',
      recentTranscript: [],
      conversationHistory: [
        { role: 'user', content: 'Here is the constraints list' },
        { role: 'assistant', content: 'Got it, O(N log N) space approach' },
      ],
    });

    expect(result).toBe('Claude 3.7 response');
    expect(capturedBody.model).toBe('claude-3-7-sonnet-20250219');
    expect(capturedHeaders['x-api-key']).toBe('sk-ant-claude37');
    expect(capturedBody.messages.length).toBe(3); // 2 history + current
    expect(capturedBody.messages[0].role).toBe('user');
    expect(capturedBody.messages[1].role).toBe('assistant');
    expect(capturedBody.messages[2].role).toBe('user');
  });

  it('streamClaude maps claude-3-5-haiku to active model ID', async () => {
    let capturedBody: any = null;

    global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return createMockSseResponse([
        JSON.stringify({
          type: 'content_block_delta',
          delta: { text: 'Haiku response' },
        }),
      ]);
    });

    await streamClaude({
      model: 'claude-3-5-haiku',
      apiKey: 'sk-ant-haiku',
      mode: 'copilot',
      query: 'Fast check',
      recentTranscript: [],
    });

    expect(capturedBody.model).toBe('claude-3-5-haiku-20241022');
  });
});
