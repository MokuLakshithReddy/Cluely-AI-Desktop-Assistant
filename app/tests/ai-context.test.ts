import { describe, it, expect } from 'vitest';
import { buildContextPrompt, MODE_SYSTEM_PROMPTS } from '../src/lib/providers';
import { chunkDocument, retrieveRelevantPassages } from '../src/lib/knowledge';
import { TranscriptItem, KnowledgeDoc } from '../src/lib/types';

describe('AI Context & Knowledge Retrieval Subsystem', () => {
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

  it('includes mode-specific system prompts with clear operational boundaries', () => {
    expect(MODE_SYSTEM_PROMPTS.copilot).toContain('personal desktop copilot');
    expect(MODE_SYSTEM_PROMPTS.interview).toContain('technical interview copilot');
    expect(MODE_SYSTEM_PROMPTS.interview).toContain('time complexity');
    expect(MODE_SYSTEM_PROMPTS.coding).toContain('debugger');
    expect(MODE_SYSTEM_PROMPTS.sales).toContain('objection');
  });

  it('chunks documents with overlapping windows', () => {
    const longText = 'Sentence A. '.repeat(100); // ~1200 characters
    const chunks = chunkDocument(longText, 300, 50);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(350);
  });

  it('retrieves relevant knowledge passages using keyword / TF-IDF scoring', () => {
    const docs: KnowledgeDoc[] = [
      {
        id: 'doc1',
        title: 'Binary Search Trees',
        content: 'Binary search tree lookup takes O(log N) on average and O(N) when degenerate.',
        chunks: ['Binary search tree lookup takes O(log N) on average and O(N) when degenerate.'],
        addedAt: new Date().toISOString(),
      },
      {
        id: 'doc2',
        title: 'Kubernetes Architecture',
        content: 'Kubelet runs on each node and maintains container lifecycle with CRI.',
        chunks: ['Kubelet runs on each node and maintains container lifecycle with CRI.'],
        addedAt: new Date().toISOString(),
      },
    ];

    const results = retrieveRelevantPassages('What is the lookup complexity of binary tree?', docs, 1);
    expect(results.length).toBe(1);
    expect(results[0]).toContain('Binary Search Trees');
    expect(results[0]).toContain('O(log N)');
  });

  it('returns empty array when query does not match any document terms', () => {
    const docs: KnowledgeDoc[] = [
      {
        id: 'doc1',
        title: 'Accounting Standards',
        content: 'GAAP principles require accrual basis revenue recognition.',
        chunks: ['GAAP principles require accrual basis revenue recognition.'],
        addedAt: new Date().toISOString(),
      },
    ];

    const results = retrieveRelevantPassages('quantum entanglement physics', docs, 1);
    expect(results).toHaveLength(0);
  });
});

