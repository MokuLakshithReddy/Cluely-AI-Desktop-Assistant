import { KnowledgeDoc } from './types';

const MAX_DOCUMENT_FILE_BYTES = 2 * 1024 * 1024;

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

/**
 * PDF.js extracts text from compressed streams, decodes supported font encodings,
 * and handles page/resource structures instead of guessing from raw PDF bytes.
 *
 * The Node test runner uses PDF.js's built-in fake worker; packaged renderers use
 * the worker asset emitted by Vite.
 */
if (typeof process === 'undefined' || !process.versions?.node) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

export async function extractTextFromPdf(buffer: ArrayBuffer): Promise<string> {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
    throw new Error('PDF input is empty or invalid.');
  }

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
  });

  const pdf = await loadingTask.promise;
  const pageTexts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map(item => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (pageText) pageTexts.push(pageText);
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  return pageTexts.join('\n\n');
}

/**
 * Parses and ingests a local File object (.txt, .md, .pdf, .json, code files)
 */
export async function parseDocumentFile(file: File): Promise<{ title: string; content: string }> {
  if (file.size > MAX_DOCUMENT_FILE_BYTES) {
    throw new Error(`File exceeds the 2 MiB ingestion limit: ${file.name}`);
  }
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
 * TF-IDF lexical ranker for local keyword retrieval.
 * This is not embedding-based semantic search; token overlap determines relevance.
 */
export function retrieveRelevantPassages(
  query: string,
  docs: KnowledgeDoc[],
  topK: number = 3
): string[] {
  if (!query.trim() || docs.length === 0 || topK <= 0) return [];

  const tokenize = (value: string): string[] =>
    value.toLowerCase().match(/[a-z0-9]+/g)?.filter(term => term.length > 2) || [];
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const chunks = docs.flatMap(doc =>
    (doc.chunks || [])
      .filter(chunk => typeof chunk === 'string' && chunk.trim().length > 0)
      .map(chunk => ({ chunk, title: doc.title, terms: tokenize(chunk) }))
  );
  if (chunks.length === 0) return [];

  // Document frequency is measured across chunks. Add-one smoothing keeps IDF
  // positive for terms present in every chunk and finite for rare terms.
  const documentFrequency = new Map<string, number>();
  for (const item of chunks) {
    for (const term of new Set(item.terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  const queryFrequency = new Map<string, number>();
  for (const term of queryTerms) queryFrequency.set(term, (queryFrequency.get(term) || 0) + 1);

  const scored = chunks.map(item => {
    const termFrequency = new Map<string, number>();
    for (const term of item.terms) termFrequency.set(term, (termFrequency.get(term) || 0) + 1);

    let score = 0;
    for (const [term, queryCount] of queryFrequency) {
      const count = termFrequency.get(term) || 0;
      if (count === 0) continue;
      const tf = count / Math.max(1, item.terms.length);
      const df = documentFrequency.get(term) || 0;
      const idf = Math.log(1 + (chunks.length + 1) / (df + 1));
      score += tf * idf * queryCount;
    }
    return { chunk: item.chunk, title: item.title, score };
  }).filter(item => item.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.floor(topK)).map(item => `[${item.title}]: ${item.chunk}`);
}
