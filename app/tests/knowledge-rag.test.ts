import { describe, it, expect } from 'vitest';
import {
  chunkDocument,
  retrieveRelevantPassages,
  createKnowledgeDoc,
  extractTextFromPdf,
} from '../src/lib/knowledge';
import { KnowledgeDoc } from '../src/lib/types';

describe('Knowledge Base & Document Retrieval (RAG) Subsystem', () => {
  it('chunks documents with overlapping windows respecting paragraph breaks', () => {
    const longText = 'Paragraph one about distributed systems.\n\nParagraph two about consensus protocols like Paxos and Raft.\n\nParagraph three discussing leader election and log replication.';
    const chunks = chunkDocument(longText, 80, 20);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('Paragraph one');
  });

  it('creates KnowledgeDoc record with correct metadata and chunks', () => {
    const doc = createKnowledgeDoc('Architecture Spec', 'Core services run in Kubernetes.', 'file', 'arch.md');
    expect(doc.id).toMatch(/^doc_/);
    expect(doc.title).toBe('Architecture Spec');
    expect(doc.sourceType).toBe('file');
    expect(doc.fileName).toBe('arch.md');
    expect(doc.chunks.length).toBe(1);
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

  it('extracts text from synthetic PDF buffer with Tj and TJ operators', async () => {
    // Construct synthetic PDF binary with text operator: (System Design Interview Notes) Tj
    const syntheticPdf = `%PDF-1.4
1 0 obj
<< /Length 50 >>
stream
BT
/F1 12 Tf
(System Design Interview Notes for Distributed Systems) Tj
ET
endstream
endobj
%%EOF`;

    const encoder = new TextEncoder();
    const buf = encoder.encode(syntheticPdf).buffer;
    const extracted = await extractTextFromPdf(buf);

    expect(extracted).toContain('System Design Interview Notes for Distributed Systems');
  });

  it('ranks higher frequency keyword occurrences with greater relevance', () => {
    const docs: KnowledgeDoc[] = [
      {
        id: 'd1',
        title: 'Casual Mention',
        content: 'We use Redis sometimes for caching.',
        chunks: ['We use Redis sometimes for caching.'],
        addedAt: new Date().toISOString(),
      },
      {
        id: 'd2',
        title: 'Deep Dive Redis',
        content: 'Redis is an in-memory data store. Redis clusters partition data using Redis hash slots with high availability.',
        chunks: ['Redis is an in-memory data store. Redis clusters partition data using Redis hash slots with high availability.'],
        addedAt: new Date().toISOString(),
      },
    ];

    const results = retrieveRelevantPassages('Redis cluster hash slots', docs, 2);
    expect(results.length).toBe(2);
    // Highest match should be Deep Dive
    expect(results[0]).toContain('Deep Dive Redis');
  });
});
