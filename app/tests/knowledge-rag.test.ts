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

  it('extracts compressed multi-page PDF text and decodes WinAnsi characters', async () => {
    const bytes = Buffer.from('JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA0IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNiAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNyAwIFIgPj4KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nID4+CmVuZG9iago2IDAgb2JqCjw8IC9MZW5ndGggODYgL0ZpbHRlciAvRmxhdGVEZWNvZGUgPj4Kc3RyZWFtCniccwpR0HczVDA0UghJUzA3AiIDhZAUBY3gyuKS1FwFl9TizPQ8Bc+8ktSisszUcgW//JLUYoW0/CIFl8zikqLMpNKS1BQFiOpiTYWQLAXXEAAgKhsDCmVuZHN0cmVhbQplbmRvYmoKNyAwIG9iago8PCAvTGVuZ3RoIDkzIC9GaWx0ZXIgL0ZsYXRlRGVjb2RlID4+CnN0cmVhbQp4nA3KvQmAMBAG0FW+Uhv/GntBF/AWCLlLiGgiXhRXdgsDr3wToV169APIYRyKDsSoVrEpMk7jBRzU3qqisMZ9CJHlDdHDlMDJ3ofEjEvyFeQxe1ODNsz0A9wFHYIKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgOAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTIxIDAwMDAwIG4gCjAwMDAwMDAyNDcgMDAwMDAgbiAKMDAwMDAwMDM3MyAwMDAwMCBuIAowMDAwMDAwNDcwIDAwMDAwIG4gCjAwMDAwMDA2MjcgMDAwMDAwIG4gCjAwMDAwMDA3OTEKJSVFT0Y=', 'base64');
    const pdf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const extracted = await extractTextFromPdf(pdf);
    expect(extracted).toContain('System Design Interview Notes for Distributed Systems');
    expect(extracted).toContain('Second page discusses café indexing and document retrieval.');
    expect(extracted.indexOf('System Design')).toBeLessThan(extracted.indexOf('Second page'));
  });

  it('returns empty text for a valid PDF page without text operators', async () => {
    const bytes = Buffer.from('JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMTMgL0ZpbHRlciAvRmxhdGVEZWNvZGUgPj4Kc3RyZWFtCniccwpRcA0BAAPdAVAKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMzOCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQyMgolJUVPRg==', 'base64');
    const pdf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(await extractTextFromPdf(pdf)).toBe('');
  });

  it('rejects malformed PDF data rather than scraping incidental printable bytes', async () => {
    const malformed = new TextEncoder().encode('not a pdf: obj stream fake text').buffer;
    await expect(extractTextFromPdf(malformed)).rejects.toThrow();
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

