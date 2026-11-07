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
    const bytes = Buffer.from('JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDggMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNyAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovQ29udGVudHMgOSAwIFIgL01lZGlhQm94IFsgMCAwIDU5NS4yNzU2IDg0MS44ODk4IF0gL1BhcmVudCA3IDAgUiAvUmVzb3VyY2VzIDw8Ci9Gb250IDEgMCBSIC9Qcm9jU2V0IFsgL1BERiAvVGV4dCAvSW1hZ2VCIC9JbWFnZUMgL0ltYWdlSSBdCj4+IC9Sb3RhdGUgMCAvVHJhbnMgPDwKCj4+IAogIC9UeXBlIC9QYWdlCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9QYWdlTW9kZSAvVXNlTm9uZSAvUGFnZXMgNyAwIFIgL1R5cGUgL0NhdGFsb2cKPj4KZW5kb2JqCjYgMCBvYmoKPDwKL0F1dGhvciAoYW5vbnltb3VzKSAvQ3JlYXRpb25EYXRlIChEOjIwMjYxMTA3MTMzMDM1KzAwJzAwJykgL0NyZWF0b3IgKGFub255bW91cykgL0tleXdvcmRzICgpIC9Nb2REYXRlIChEOjIwMjYxMTA3MTMzMDM1KzAwJzAwJykgL1Byb2R1Y2VyIChSZXBvcnRMYWIgUERGIExpYnJhcnkgLSBcKG9wZW5zb3VyY2VcKSkgCiAgL1N1YmplY3QgKHVuc3BlY2lmaWVkKSAvVGl0bGUgKHVudGl0bGVkKSAvVHJhcHBlZCAvRmFsc2UKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0NvdW50IDIgL0tpZHMgWyAzIDAgUiA0IDAgUiBdIC9UeXBlIC9QYWdlcwo+PgplbmRvYmoKOCAwIG9iago8PAovRmlsdGVyIFsgL0FTQ0lJODVEZWNvZGUgL0ZsYXRlRGVjb2RlIF0gL0xlbmd0aCAxNDYKPj4Kc3RyZWFtCkdhcEBFYjZsKk8mLVZJdE1FN2FCYyVMVWtNI2ZvVDMrJj1SQTsqYGNHPyJLZWYqQy4oVGRYKkM5QjxfSiNUSUAqJGR0W01kT25hR2NXNypgamZiaFZkTWUraE5qJWRia3ElVlVhRFEpbU8na2BuUD9WWGQmbWBTTV9XZ0szaUZoPTZIOiZMQD0vbjQ+UW0zNH4+ZW5kc3RyZWFtCmVuZG9iago5IDAgb2JqCjw8Ci9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXSAvTGVuZ3RoIDE1Nwo+PgpzdHJlYW0KR2FwQEU0ViotMCY0Q2tvYEtXdUcvMEQsVWRFOWBkQmVGYD8zVEQtNyI2N19qK0NsZnRdWSJaSDlWSG1SIiNuNl02KGVTP0s6OE04NUI1ajtFQjtUYlEhL2MmOitxa2U9RkFBZFlWKycyVUlMKChdPUs7dUAuaiEqITBcQmFiMlA7JlF1bnBpcmxoOSJLQVlVN10xOToyKnFDVkp+PmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDEwCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA2MSAwMDAwMCBuIAowMDAwMDAwMDkyIDAwMDAwIG4gCjAwMDAwMDAxOTkgMDAwMDAwIG4gCjAwMDAwMDA0MDIgMDAwMDAwIG4gCjAwMDAwMDA2MDUgMDAwMDAwIG4gCjAwMDAwMDA2NzMgMDAwMDAwIG4gCjAwMDAwMDA5MzQgMDAwMDAwIG4gCjAwMDAwMDA5OTkgMDAwMDAwIG4gCjAwMDAwMDEyMzUgMDAwMDAwIG4gCjAwMDAwMDE0ODIKJSVFT0Y=', 'base64');
    const pdf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const extracted = await extractTextFromPdf(pdf);
    expect(extracted).toContain('System Design Interview Notes for Distributed Systems');
    expect(extracted).toContain('Second page discusses café indexing and document retrieval.');
    expect(extracted.indexOf('System Design')).toBeLessThan(extracted.indexOf('Second page'));
  });

  it('returns empty text for a valid PDF page without text operators', async () => {
    const bytes = Buffer.from('JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNiAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDYgMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9BdXRob3IgKGFub255bW91cykgL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MTEwNzEzMzAzNSswMCcwMCcpIC9DcmVhdG9yIChhbm9ueW1vdXMpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDI2MTEwNzEzMzAzNSswMCcwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0ICh1bnNwZWNpZmllZCkgL1RpdGxlICh1bnRpdGxlZCkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Db3VudCAxIC9LaWRzIFsgMyAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2RlIC9GbGF0ZURlY29kZSBdIC9MZW5ndGggNTkKPj4Kc3RyZWFtCkdhcFFoMEU9RiwwVVxIM1RccE5ZVF5RS2s/dGM+SVAsO1cjVTFeMjNpaFBFTV9QUCRPITNeLEM1UX4+ZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgOAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwNjEgMDAwMDAwIG4gCjAwMDAwMDAwOTIgMDAwMDAwIG4gCjAwMDAwMDAxOTkgMDAwMDAwIG4gCjAwMDAwMDA0MDIgMDAwMDAwIG4gCjAwMDAwMDA0NzAgMDAwMDAwIG4gCjAwMDAwMDA3MzEgMDAwMDAwIG4gCjAwMDAwMDA3OTAKdHJhaWxlcgo8PAovSUQgCls8ZDUwNTczOTU0MTk4YzA4ZmQ3MjBlYjQ5MDNjZGNmMzQ+PGQ1MDU3Mzk1NDE5OGMwOGZkNzIwZWI0OTAzY2RjZjM0Pl0KJSBSZXBvcnRMYWIgZ2VuZXJhdGVkIFBERiBkb2N1bWVudCAtLSBkaWdlc3QgKG9wZW5zb3VyY2UpCgovSW5mbyA1IDAgUgovUm9vdCA0IDAgUgovU2l6ZSA4Cj4+CnN0YXJ0eHJlZgo5MzgKJSVFT0Y=', 'base64');
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

