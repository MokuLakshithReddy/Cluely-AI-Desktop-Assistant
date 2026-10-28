import { describe, it, expect } from 'vitest';
import { buildContextPrompt, MODE_SYSTEM_PROMPTS } from '../src/lib/providers';
import { TranscriptItem } from '../src/lib/types';

describe('AI Context Synthesis & Multimodal Provider Subsystem', () => {
  it('builds context prompt including speaker-attributed transcripts', () => {
    const transcripts: TranscriptItem[] = [
      {
        id: '1',
        createdAt: new Date().toISOString(),
        relativeMs: 1000,
        role: 'them',
        status: 'ready',
        text: 'Can you explain how quicksort handles worst-case time complexity?',
      },
      {
        id: '2',
        createdAt: new Date().toISOString(),
        relativeMs: 2000,
        role: 'me',
        status: 'ready',
        text: 'Sure, when the pivot is chosen naively as the first element.',
      },
    ];

    const prompt = buildContextPrompt('Provide optimal pivot strategies', 'interview', transcripts, []);

    expect(prompt).toContain('### RECENT CONVERSATION TRANSCRIPT');
    expect(prompt).toContain('[Remote Speaker]: Can you explain how quicksort');
    expect(prompt).toContain('[You]: Sure, when the pivot is chosen');
    expect(prompt).toContain('### USER REQUEST');
    expect(prompt).toContain('Provide optimal pivot strategies');
  });

  it('filters out error and incomplete transcript segments from prompt context', () => {
    const transcripts: TranscriptItem[] = [
      {
        id: '1',
        createdAt: new Date().toISOString(),
        relativeMs: 500,
        role: 'me',
        status: 'error',
        text: '[Transcription Failed]',
        error: 'Network timeout',
      },
      {
        id: '2',
        createdAt: new Date().toISOString(),
        relativeMs: 1000,
        role: 'them',
        status: 'ready',
        text: 'What are the trade-offs of microservices?',
      },
    ];

    const prompt = buildContextPrompt('Summarize key points', 'copilot', transcripts);
    expect(prompt).not.toContain('[Transcription Failed]');
    expect(prompt).toContain('What are the trade-offs of microservices?');
  });

  it('includes mode-specific system prompts with clear operational boundaries', () => {
    expect(MODE_SYSTEM_PROMPTS.copilot).toContain('personal desktop copilot');
    expect(MODE_SYSTEM_PROMPTS.interview).toContain('technical interview copilot');
    expect(MODE_SYSTEM_PROMPTS.interview).toContain('time complexity');
    expect(MODE_SYSTEM_PROMPTS.coding).toContain('debugger');
    expect(MODE_SYSTEM_PROMPTS.sales).toContain('objection');
    expect(MODE_SYSTEM_PROMPTS.executive).toContain('decisions made');
  });

  it('integrates retrieved knowledge passages with clear source tagging', () => {
    const passages = [
      '[System Architecture]: Microservices communicate via gRPC over HTTP/2.',
      '[Database Guide]: PostgreSQL handles transactions with MVCC isolation.',
    ];

    const prompt = buildContextPrompt('How does our API communicate?', 'coding', [], passages);
    expect(prompt).toContain('### RETRIEVED REFERENCE DOCUMENTS & NOTES');
    expect(prompt).toContain('[Source 1]:');
    expect(prompt).toContain('Microservices communicate via gRPC');
    expect(prompt).toContain('[Source 2]:');
    expect(prompt).toContain('PostgreSQL handles transactions');
  });

  it('handles empty query gracefully with contextual default instruction', () => {
    const prompt = buildContextPrompt('', 'copilot', []);
    expect(prompt).toContain('Based on the screen and recent conversation, provide the next helpful answer');
  });

  it('verifies system prompt presence across all 5 defined assistance modes', () => {
    const modes = ['copilot', 'interview', 'coding', 'sales', 'executive'] as const;
    for (const m of modes) {
      expect(MODE_SYSTEM_PROMPTS[m]).toBeDefined();
      expect(MODE_SYSTEM_PROMPTS[m].length).toBeGreaterThan(50);
    }
  });

  it('formats user request cleanly when query contains multiline strings', () => {
    const multiline = 'Line 1\nLine 2\nLine 3';
    const prompt = buildContextPrompt(multiline, 'copilot', []);
    expect(prompt).toContain('### USER REQUEST\nLine 1\nLine 2\nLine 3');
  });
});
