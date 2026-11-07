import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  chunkDocument,
  retrieveRelevantPassages,
  createKnowledgeDoc,
  extractTextFromPdf,
} from '../src/lib/knowledge';
import { KnowledgeDoc } from '../src/lib/types';


// Builds a small but structurally valid PDF with Flate-compressed page streams.
function buildTextPdf(pageTexts: string[]): ArrayBuffer {
  const pageObjectIds = pageTexts.map((_, index) => 3 + index);
  const fontObjectId = 3 + pageTexts.length;
  const firstContentObjectId = fontObjectId + 1;

  const objectBodies: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from(`<< /Type /Pages /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`, 'ascii'),
    ...pageTexts.map((_, index) => Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${firstContentObjectId + index} 0 R >>`,
      'ascii'
    )),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'ascii'),
    ...pageTexts.map(text => {
      const commands = text
        ? `BT /F1 12 Tf 72 720 Td (${text.replace(/([\\()])/g, '\\\\$1')}) Tj ET`
        : 'BT ET';
      const compressed = deflateSync(Buffer.from(commands, 'latin1'));
      return Buffer.concat([
        Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\\nstream\\n`, 'ascii'),
        compressed,
        Buffer.from('\\nendstream', 'ascii'),
      ]);
    }),
  ];

  const parts: Buffer[] = [Buffer.from('%PDF-1.7\\n', 'ascii')];
  const offsets = [0];
  let byteLength = parts[0].length;
  objectBodies.forEach((body, index) => {
    offsets.push(byteLength);
    const header = Buffer.from(`${index + 1} 0 obj\\n`, 'ascii');
    const footer = Buffer.from('\\nendobj\\n', 'ascii');
    parts.push(header, body, footer);
    byteLength += header.length + body.length + footer.length;
  });

  const xrefOffset = byteLength;
  const xref = [
    `xref\\n0 ${objectBodies.length + 1}\\n`,
    '0000000000 65535 f \\n',
    ...offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \\n`),
    `trailer\\n<< /Size ${objectBodies.length + 1} /Root 1 0 R >>\\nstartxref\\n${xrefOffset}\\n%%EOF`,
  ].join('');
  parts.push(Buffer.from(xref, 'ascii'));

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

  it('extracts compressed, multi-page PDF text and decodes WinAnsi characters', async () => {
    const pdf = buildTextPdf([
      'System Design Interview Notes for Distributed Systems',
      'Second page discusses café indexing and document retrieval.',
    ]);
    const extracted = await extractTextFromPdf(pdf);

    expect(extracted).toContain('System Design Interview Notes for Distributed Systems');
    expect(extracted).toContain('Second page discusses café indexing');
    expect(extracted.indexOf('System Design')).toBeLessThan(extracted.indexOf('Second page'));
  });

  it('returns empty text for a valid PDF page without text operators', async () => {
    const extracted = await extractTextFromPdf(buildTextPdf(['']));
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

