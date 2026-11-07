import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  chunkDocument,
  retrieveRelevantPassages,
  createKnowledgeDoc,
  extractTextFromPdf,
} from '../src/lib/knowledge';
import { KnowledgeDoc } from '../src/lib/types';


function buildCompressedPdf(pageTexts: string[]): ArrayBuffer {
  const nl = String.fromCharCode(10);
  const pageCount = pageTexts.length;
  const firstPageId = 3;
  const fontId = firstPageId + pageCount;
  const firstContentId = fontId + 1;
  const bodies: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [' + pageTexts.map((_, i) => (firstPageId + i) + ' 0 R').join(' ') + '] /Count ' + pageCount + ' >>', 'ascii'),
    ...pageTexts.map((_, i) => Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ' + fontId + ' 0 R >> >> /Contents ' + (firstContentId + i) + ' 0 R >>', 'ascii')),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'ascii'),
    ...pageTexts.map(text => {
      const content = Buffer.from('BT /F1 12 Tf 72 720 Td (' + text + ') Tj ET', 'latin1');
      const compressed = deflateSync(content);
      return Buffer.concat([
        Buffer.from('<< /Length ' + compressed.length + ' /Filter /FlateDecode >>' + nl + 'stream' + nl, 'ascii'),
        compressed,
        Buffer.from(nl + 'endstream', 'ascii'),
      ]);
    }),
  ];
  const header = Buffer.from('%PDF-1.7' + nl, 'ascii');
  const parts: Buffer[] = [header];
  const offsets = [0];
  let cursor = header.length;
  bodies.forEach((body, index) => {
    offsets.push(cursor);
    const objectHeader = Buffer.from((index + 1) + ' 0 obj' + nl, 'ascii');
    const objectFooter = Buffer.from(nl + 'endobj' + nl, 'ascii');
    parts.push(objectHeader, body, objectFooter);
    cursor += objectHeader.length + body.length + objectFooter.length;
  });
  const xrefOffset = cursor;
  const xrefLines = ['xref', '0 ' + (bodies.length + 1), '0000000000 65535 f '];
  offsets.slice(1).forEach(offset => xrefLines.push(String(offset).padStart(10, '0') + ' 00000 n '));
  const xref = Buffer.from(xrefLines.join(nl) + nl + 'trailer' + nl + '<< /Size ' + (bodies.length + 1) + ' /Root 1 0 R >>' + nl + 'startxref' + nl + xrefOffset + nl + '%%EOF', 'ascii');
  parts.push(xref);
  const pdf = Buffer.concat(parts);
  return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
}
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
    const pdf = buildCompressedPdf([
      'System Design Interview Notes for Distributed Systems',
      'Second page discusses café indexing and document retrieval.',
    ]);
    const extracted = await extractTextFromPdf(pdf);
    expect(extracted).toContain('System Design Interview Notes for Distributed Systems');
    expect(extracted).toContain('Second page discusses café indexing and document retrieval.');
    expect(extracted.indexOf('System Design')).toBeLessThan(extracted.indexOf('Second page'));
  });
  it('returns empty text for a valid PDF page without text operators', async () => {
    const extracted = await extractTextFromPdf(buildCompressedPdf(['']));
    expect(extracted).toBe('');
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

