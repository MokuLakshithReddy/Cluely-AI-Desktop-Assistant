import { KnowledgeDoc } from './types';

/**
 * Chunks text content into overlapping passages
 */
export function chunkDocument(text: string, chunkSize: number = 500, overlap: number = 80): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= chunkSize) return [clean];

  const chunks: string[] = [];
  let start = 0;

  while (start < clean.length) {
    let end = start + chunkSize;
    if (end < clean.length) {
      // Look for a clean boundary (newline or period)
      const nextBreak = clean.lastIndexOf('\n', end);
      const nextPeriod = clean.lastIndexOf('. ', end);
      const bestBreak = Math.max(nextBreak, nextPeriod);
      if (bestBreak > start + chunkSize * 0.5) {
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
 * Simple TF-IDF / Term Frequency ranker for local semantic retrieval
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
        // Count occurrences
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

