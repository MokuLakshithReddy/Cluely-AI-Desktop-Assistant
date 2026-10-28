import { KnowledgeDoc } from './types';

/**
 * Extracts plain text from binary PDF file data without external native dependencies.
 * Parses PDF text operators (BT...ET, Tj, TJ) and text streams.
 */
export async function extractTextFromPdf(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  let textContent = '';

  // Convert bytes to string for token parsing
  let binaryStr = '';
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    binaryStr += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + step, bytes.length)))
    );
  }

  // 1. Match Tj text blocks: (Some Text) Tj
  const tjRegex = /\(([^)]+)\)\s*Tj/g;
  let match;
  while ((match = tjRegex.exec(binaryStr)) !== null) {
    const clean = match[1].replace(/\\([()\\])/g, '$1');
    textContent += clean + ' ';
  }

  // 2. Match TJ array blocks: [(Part 1) 20 (Part 2)] TJ
  const tjArrayRegex = /\[([^\]]+)\]\s*TJ/g;
  while ((match = tjArrayRegex.exec(binaryStr)) !== null) {
    const inner = match[1];
    const subRegex = /\(([^)]+)\)/g;
    let subMatch;
    while ((subMatch = subRegex.exec(inner)) !== null) {
      const clean = subMatch[1].replace(/\\([()\\])/g, '$1');
      textContent += clean + ' ';
    }
  }

  // 3. Fallback: If minimal PDF operators were found, extract printable ASCII sequences
  if (textContent.trim().length < 50) {
    const asciiRegex = /[a-zA-Z0-9.,;:!?'"()\s\-_]{6,}/g;
    const asciiMatches = binaryStr.match(asciiRegex) || [];
    // Filter out PDF syntax keywords
    const filtered = asciiMatches.filter(
      s => !s.includes('obj') && !s.includes('endobj') && !s.includes('xref') && !s.includes('stream')
    );
    textContent = filtered.join('\n');
  }

  return textContent.trim();
}

/**
 * Parses and ingests a local File object (.txt, .md, .pdf, .json, code files)
 */
export async function parseDocumentFile(file: File): Promise<{ title: string; content: string }> {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';

  if (ext === 'pdf') {
    const arrayBuffer = await file.arrayBuffer();
    const extracted = await extractTextFromPdf(arrayBuffer);
    if (!extracted) {
      throw new Error(`Could not extract readable text from PDF: ${file.name}`);
    }
    return {
      title: file.name,
      content: extracted,
    };
  }

  // Text-based formats (.txt, .md, .json, .ts, .py, etc.)
  const text = await file.text();
  return {
    title: file.name,
    content: text,
  };
}

/**
 * Chunks text content into overlapping passages respecting paragraph and section headers
 */
export function chunkDocument(text: string, chunkSize: number = 500, overlap: number = 80): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= chunkSize) return [clean];

  const chunks: string[] = [];
  let start = 0;

  while (start < clean.length) {
    let end = start + chunkSize;
    if (end < clean.length) {
      // Look for a clean boundary: markdown headers, paragraphs, or sentence periods
      const nextHeader = clean.lastIndexOf('\n#', end);
      const nextParagraph = clean.lastIndexOf('\n\n', end);
      const nextPeriod = clean.lastIndexOf('. ', end);

      const bestBreak = Math.max(nextHeader, nextParagraph, nextPeriod);
      if (bestBreak > start + chunkSize * 0.4) {
        end = bestBreak + 1;
      }
    } else {
      end = clean.length;
    }

    const chunk = clean.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= clean.length) break;
    start = end - overlap;
  }

  return chunks;
}

/**
 * Ingests a raw text note or parsed file into a KnowledgeDoc record
 */
export function createKnowledgeDoc(
  title: string,
  content: string,
  sourceType: 'pasted' | 'file' = 'pasted',
  fileName?: string
): KnowledgeDoc {
  const chunks = chunkDocument(content);
  return {
    id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: title.trim(),
    content: content.trim(),
    chunks,
    addedAt: new Date().toISOString(),
    sourceType,
    fileName,
  };
}

/**
 * BM25 / TF-IDF ranker for local semantic retrieval
 */
export function retrieveRelevantPassages(
  query: string,
  docs: KnowledgeDoc[],
  topK: number = 3
): string[] {
  if (!query || docs.length === 0) return [];

  // Extract query keywords (ignoring short stopwords)
  const queryTerms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(t => t.length > 2);

  if (queryTerms.length === 0) return [];

  interface ScoredChunk {
    chunk: string;
    score: number;
    title: string;
  }

  const scored: ScoredChunk[] = [];

  for (const doc of docs) {
    for (const chunk of doc.chunks) {
      const lowerChunk = chunk.toLowerCase();
      let matchCount = 0;

      for (const term of queryTerms) {
        let pos = 0;
        while ((pos = lowerChunk.indexOf(term, pos)) !== -1) {
          matchCount++;
          pos += term.length;
        }
      }

      if (matchCount > 0) {
        scored.push({
          chunk,
          score: matchCount / Math.sqrt(chunk.length),
          title: doc.title,
        });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK).map(s => `[${s.title}]: ${s.chunk}`);
}
