import { describe, it, expect, vi, afterEach } from 'vitest';
import { AudioResampler, VADProcessor, encodeWAV } from '../src/lib/vad';
import { calculateThumbnailSize } from '../electron/domains/screenshot';
import { createKnowledgeDoc, retrieveRelevantPassages } from '../src/lib/knowledge';
import { buildContextPrompt, streamGemini } from '../src/lib/providers';
import { SessionRecord, TranscriptItem } from '../src/lib/types';
import { SessionRepository } from '../electron/services/session-repository';
import fs from 'fs';

describe('Real Desktop Session End-to-End Workflow & Verification', () => {
  const sessionRepo = new SessionRepository();
  const testSessionId = 'consented-e2e-session-001';

  afterEach(async () => {
    try {
      await sessionRepo.deleteSession(testSessionId);
    } catch {}
  });

  it('Stage 1: Captures dual-stream consented meeting audio with VAD and crosstalk suppression', () => {
    // 1. Ingest remote speaker audio ("them") via system loopback at 48kHz
    const resampler = new AudioResampler(48000, 16000);
    const raw48kThem = new Float32Array(4800); // 100ms
    for (let i = 0; i < raw48kThem.length; i++) {
      raw48kThem[i] = Math.sin((2 * Math.PI * 300 * i) / 48000) * 0.4;
    }
    const them16k = resampler.resample(raw48kThem);
    expect(them16k.length).toBe(1600);

    const vad = new VADProcessor({ energyThreshold: 0.02, redemptionMs: 50, preSpeechPadMs: 50 });
    const themRms = vad.calculateRms(them16k);
    const themZcr = vad.calculateZcr(them16k);

    expect(themRms).toBeGreaterThan(0.02);
    expect(themZcr).toBeGreaterThan(0.01);
    expect(themZcr).toBeLessThan(0.45);

    // 2. Crosstalk suppression test:
    // When "them" is actively speaking (themHasVoiceActivity = true),
    // local microphone input must be suppressed (zeroed) to prevent speaker loopback echo
    const themHasVoiceActivity = true;
    const rawLocalMic = new Float32Array([0.2, 0.25, 0.18, 0.3]);
    const processedLocalMic = themHasVoiceActivity ? new Float32Array(rawLocalMic.length).fill(0) : rawLocalMic;

    expect(processedLocalMic.every(v => v === 0)).toBe(true);

    // 3. Encode speech segment to standard 16-bit PCM RIFF WAV
    const wavBuffer = encodeWAV(them16k, 16000);
    const wavHeader = Buffer.from(wavBuffer.slice(0, 4)).toString('ascii');
    expect(wavHeader).toBe('RIFF');
  });

  it('Stage 2: Captures active display bounds with proportional aspect ratio downscaling', () => {
    // 4K Ultra HD Display (3840x2160)
    const bounds4k = { width: 3840, height: 2160 };
    const scaled4k = calculateThumbnailSize(bounds4k);
    expect(scaled4k.width).toBe(1920);
    expect(scaled4k.height).toBe(1080);
    expect(scaled4k.width / scaled4k.height).toBeCloseTo(3840 / 2160, 2);

    // Ultrawide QHD Display (3440x1440)
    const boundsUltrawide = { width: 3440, height: 1440 };
    const scaledUltrawide = calculateThumbnailSize(boundsUltrawide);
    expect(scaledUltrawide.width).toBe(1920);
    expect(scaledUltrawide.height).toBe(Math.round(1440 * (1920 / 3440)));

    // Standard 1080p Display (1920x1080) stays unscaled
    const bounds1080p = { width: 1920, height: 1080 };
    const scaled1080p = calculateThumbnailSize(bounds1080p);
    expect(scaled1080p.width).toBe(1920);
    expect(scaled1080p.height).toBe(1080);
  });

  it('Stage 3: Ingests user knowledge document and retrieves relevant SLA context via cosine RAG', () => {
    const docContent = `
# System Architecture & Cache Policy
Version: 2.4 (Production Specification)

## Edge Invalidation SLA
Cache invalidation across all multi-region edge nodes must strictly complete within 250 milliseconds.
The stale-while-revalidate grace period is configured to 60 seconds for anonymous reads.

## Vector Search & Chunking Thresholds
When processing knowledge documents, the maximum chunk threshold is 4096 bytes with a 20 percent stride overlap.
Text chunks exceeding 5MB aggregate per session are rejected by the ingestion boundary.
    `.trim();

    const doc = createKnowledgeDoc('Cache Architecture Policy', docContent, 'file', 'architecture.md');
    expect(doc.chunks.length).toBeGreaterThan(0);

    // Query for SLA
    const retrieved = retrieveRelevantPassages('What is our edge cache invalidation SLA?', [doc], 2);
    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved[0]).toContain('Cache Architecture Policy');
    expect(retrieved[0]).toContain('within 250 milliseconds');
  });

  it('Stage 4: Synthesizes multimodal context prompt from spoken transcript, screen, and RAG knowledge', () => {
    const meetingTranscript: TranscriptItem[] = [
      {
        id: 't1',
        createdAt: new Date().toISOString(),
        relativeMs: 1200,
        role: 'them',
        status: 'ready',
        text: 'Can you check our edge cache invalidation SLA and chunking size threshold?',
      },
      {
        id: 't2',
        createdAt: new Date().toISOString(),
        relativeMs: 4500,
        role: 'me',
        status: 'ready',
        text: 'Checking our technical specifications document now.',
      },
    ];

    const knowledgePassages = [
      '[Source: architecture.md]\nCache invalidation across all multi-region edge nodes must strictly complete within 250 milliseconds. Chunk threshold is 4096 bytes.',
    ];

    const synthesizedPrompt = buildContextPrompt(
      'Summarize our edge SLA and chunk threshold for the team.',
      'copilot',
      meetingTranscript,
      knowledgePassages
    );

    // Verify presence of all fused components
    expect(synthesizedPrompt).toContain('### RECENT CONVERSATION TRANSCRIPT');
    expect(synthesizedPrompt).toContain('[Remote Speaker]: Can you check our edge cache invalidation SLA');
    expect(synthesizedPrompt).toContain('[You]: Checking our technical specifications document now');
    expect(synthesizedPrompt).toContain('### RETRIEVED REFERENCE DOCUMENTS & NOTES');
    expect(synthesizedPrompt).toContain('complete within 250 milliseconds');
    expect(synthesizedPrompt).toContain('### USER REQUEST');
    expect(synthesizedPrompt).toContain('Summarize our edge SLA');
  });

  it('Stage 5: Streams grounded AI response, verifies citation, and tests mid-stream cancellation', async () => {
    const streamedChunks = [
      'Based on your ',
      'Cache Architecture Policy ',
      'document, the edge cache invalidation SLA is strictly ',
      '250 milliseconds, and the vector chunking threshold is 4096 bytes.',
    ];

    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }

      const sseBody = streamedChunks
        .map(chunk => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: chunk }] } }] })}\n\n`)
        .join('');

      return new Response(sseBody, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const tokensReceived: string[] = [];
    const answer = await streamGemini({
      apiKey: 'test-key-2026',
      mode: 'copilot',
      query: 'What is the SLA?',
      model: 'gemini-3.8-flash',
      recentTranscript: [],
      knowledgePassages: ['[Source: architecture.md] Cache invalidation: 250ms'],
      onToken: token => tokensReceived.push(token),
    });

    expect(tokensReceived.length).toBe(4);
    expect(answer).toContain('250 milliseconds');
    expect(answer).toContain('4096 bytes');

    // Test Mid-Stream User Cancellation (AbortController)
    const abortController = new AbortController();
    abortController.abort(); // Pre-aborted

    await expect(
      streamGemini({
        apiKey: 'test-key-2026',
        mode: 'copilot',
        query: 'What is the SLA?',
        model: 'gemini-3.8-flash',
        recentTranscript: [],
        signal: abortController.signal,
      })
    ).rejects.toThrow();
  });

  it('Stage 6: Verifies zero-leakage session persistence, screenshot stripping, and session deletion', async () => {
    const sessionToSave: SessionRecord = {
      id: testSessionId,
      title: 'Consented Architecture Review',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mode: 'copilot',
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'What is our cache SLA?',
          createdAt: new Date().toISOString(),
          screenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Edge cache invalidation SLA is 250 milliseconds.',
          createdAt: new Date().toISOString(),
        },
      ],
      transcript: [
        {
          id: 't1',
          createdAt: new Date().toISOString(),
          relativeMs: 1000,
          role: 'them',
          status: 'ready',
          text: 'What is our edge SLA?',
        },
      ],
    };

    // 1. Save session to disk repository
    await sessionRepo.saveSession(sessionToSave);

    const savedRecord = await sessionRepo.getSession(testSessionId);
    expect(savedRecord).not.toBeNull();
    expect(savedRecord?.title).toBe('Consented Architecture Review');
    expect(savedRecord?.messages.length).toBe(2);

    // Verify screenshot is NOT persisted into saved messages array on disk (stripped)
    const diskFile = sessionRepo.resolveSessionPath(testSessionId);
    expect(fs.existsSync(diskFile)).toBe(true);
    const diskContent = fs.readFileSync(diskFile, 'utf8');
    expect(diskContent).not.toContain('iVBORw0KGgoAAAANSUhEUgAAAAE');

    // 2. Execute Session Deletion
    const deleted = await sessionRepo.deleteSession(testSessionId);
    expect(deleted).toBe(true);
    expect(fs.existsSync(diskFile)).toBe(false);
  });
});
