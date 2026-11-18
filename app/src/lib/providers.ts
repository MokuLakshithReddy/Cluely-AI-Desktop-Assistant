import { AssistantMode, TranscriptItem } from './types';
import { assertModelCompatibleWithProvider } from './model-registry';
import { redactSensitiveText } from './redaction';

export interface GenerationOptions {
  model: string;
  apiKey?: string;
  mode: AssistantMode;
  query: string;
  screenshotBase64?: string;
  recentTranscript: TranscriptItem[];
  knowledgePassages?: string[];
  conversationHistory?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onToken?: (token: string) => void;
}

export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
export const DEFAULT_STT_TIMEOUT_MS = 30_000;
export const ANTHROPIC_API_VERSION = '2026-10-21';

export const MODE_SYSTEM_PROMPTS: Record<AssistantMode, string> = {
  copilot: `You are an expert personal desktop copilot running alongside the user's active applications.
CRITICAL OUTPUT RULES:
- Provide ONLY the direct solutions, answers, code, or essays for the questions or problems displayed on the screen.
- NEVER describe what you see on the screen (NEVER write "Context:", "The visible screen shows...", "The screenshot displays...", or summarize the visual layout). The user is already looking at their screen.
- NEVER include meta labels or conversational filler like "Draft Response:", "Suggested Response:", "Here is the answer:", or "Based on your screen:".
- If questions, exercises, or assignments are displayed on screen (such as Question 1, Question 2, multiple choice questions, word problems, or prompts), directly output the exact answer or solution for each question.
- If multiple questions or numbered blanks are visible, label each one sequentially (e.g. "**Question 1:** [Solution]\n\n**Question 2:** [Solution]").
- For fill-in-the-blank, C-Test, or missing-letter exercises:
  1. Scan and locate EVERY blank or input box sequentially in exact reading order. Never skip short words (e.g. "from", "to", "and") and never treat already printed plain words as blanks.
  2. If a prefix is printed before the box (e.g. "oft[...]", "fr[...]", "see[...]"), provide both the exact missing letters to type and the complete word (e.g. "Question 1: en (often)" or "Question 1: often [type: en]").
  3. Ensure grammatical correctness with the surrounding context (e.g. correct verb form/participle like "seeking", tense, pluralization).
- Be extremely direct, concise, and fast. Format code in clean markdown blocks with syntax highlighting.
- Ground your answers strictly on the visible screen context, recent live conversation transcripts, and supplied notes.`,

  interview: `You are a discreet, world-class technical interview copilot.
Your user is in a live coding interview or technical evaluation.
CRITICAL OUTPUT RULES:
- NEVER describe the screen or write "Context:".
- Jump directly into the solution for the problem on screen:
1. Optimal algorithm name, time complexity O(...) and space complexity O(...).
2. Concise high-level approach in 2-3 bullet points.
3. Clean, bug-free implementation code.
4. 2 key talking points the user can naturally say aloud to the interviewer.
Be extremely succinct and scannable. Do not provide unnecessary conversational filler.`,

  coding: `You are an elite software engineering copilot and debugger.
CRITICAL OUTPUT RULES:
- NEVER describe the screen or write "Context:".
- Analyze code snippets, terminal outputs, stack traces, and compiler errors on screen.
- Directly identify the root cause immediately and provide the exact diff or fix.
- Explain why the issue occurred in one concise sentence.`,

  sales: `You are a strategic live sales and negotiation copilot.
CRITICAL OUTPUT RULES:
- NEVER describe the screen or write "Context:".
- Listen to client questions and objections in the conversation transcript:
1. Core objection or underlying concern.
2. 2-sentence conversational response using proven frameworks (Feel-Felt-Found, Question-Before-Answer).
3. Closing or qualifying follow-up question.`,

  executive: `You are an executive chief of staff and meeting intelligence copilot.
CRITICAL OUTPUT RULES:
- NEVER describe the screen or write "Context:".
- Summarize the discussion on screen and in the transcript:
1. Core decisions made.
2. Action items with assignees if mentioned.
3. Unresolved questions and immediate next steps.`
};

/**
 * Enforces network transport security for outbound API requests.
 * Rejects insecure http:// endpoints for remote AI services.
 */
export function validateNetworkEndpoint(urlStr: string, allowLocalHttp: boolean = true): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`[Network Security Guard] Invalid endpoint URL: "${urlStr}"`);
  }

  if (parsed.protocol === 'https:') {
    return parsed;
  }

  if (allowLocalHttp && parsed.protocol === 'http:') {
    const isLocalhost =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]';
    if (isLocalhost) {
      return parsed;
    }
  }

  throw new Error(
    `[Network Security Guard] Insecure HTTP endpoint rejected: "${urlStr}". Remote cloud AI endpoints must enforce HTTPS with valid certificates.`
  );
}

/**
 * Scrubs any echoed API keys or sensitive tokens from upstream error payloads
 * and caps error detail length so error messages remain diagnostic without leaking secrets.
 */
export function sanitizeProviderErrorBody(rawText: string, apiKey?: string): string {
  let safe = typeof rawText === 'string' ? rawText : '';
  const trimmedKey = apiKey?.trim();
  if (trimmedKey && trimmedKey.length >= 6) {
    safe = safe.split(trimmedKey).join('[REDACTED_API_KEY]');
  }
  safe = redactSensitiveText(safe).sanitized;
  safe = safe.replace(/\s+/g, ' ').trim();
  if (safe.length > 400) {
    safe = `${safe.slice(0, 400)}…`;
  }
  return safe || 'No additional error details returned by provider.';
}

/**
 * Composes an optional caller AbortSignal with a bounded request timeout.
 */
function createBoundedFetchController(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; didTimeout: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else if (callerSignal) {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, Math.max(1, timeoutMs));
  if (typeof timer.unref === 'function') timer.unref();

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

function classifyHttpError(
  providerLabel: string,
  status: number,
  sanitizedDetail: string,
  modelName?: string
): Error {
  if (status === 401) {
    return new Error(
      `${providerLabel} authentication error (401): Invalid or revoked API key. Update your key in Settings. Details: ${sanitizedDetail}`
    );
  }
  if (status === 429) {
    return new Error(
      `${providerLabel} rate limit exceeded (429): Too many requests or quota exhausted. Retry shortly. Details: ${sanitizedDetail}`
    );
  }
  if (status >= 500 && status <= 599) {
    return new Error(
      `${providerLabel} service outage (${status}): Upstream provider is temporarily unavailable. Details: ${sanitizedDetail}`
    );
  }
  const modelNote = modelName ? ` for model "${modelName}"` : '';
  return new Error(`${providerLabel} API error (${status})${modelNote}: ${sanitizedDetail}`);
}

/**
 * Strips verbose screen context descriptions and meta headers from model responses.
 * Ensures the user receives only direct answers and solutions without preambles like:
 * "Context: The visible screen shows..." or "Draft Response:".
 */
export function cleanAssistantSolution(text: string): string {
  if (!text) return text;

  const contextBlockMatch = text.match(
    /^[\s*•\-#]*(\*{0,2}(?:Context|Screen Context|Screen Analysis|Visible Screen)\*{0,2}:?[\s\S]*?)(?:\n\s*[\s*•\-#]*\*{0,2}(?:Draft Response|Response|Suggested Response|Solution|Answer|Suggested Answer)\*{0,2}:?|\n{2,}|$)/i
  );

  if (contextBlockMatch) {
    if (contextBlockMatch[0].length === text.length && !text.includes('\n\n') && !/\b(?:response|answer|solution):/i.test(text)) {
      return '';
    }
    const matchedPrefix = contextBlockMatch[0];
    const remainder = text
      .slice(matchedPrefix.length)
      .replace(/^[\s*•\-#]*(\*{0,2}(?:Draft Response|Response|Suggested Response|Solution|Answer|Suggested Answer)\*{0,2}:?\s*\n*)/i, '');
    return remainder.trimStart();
  }

  return text
    .replace(/^[\s*•\-#]*(\*{0,2}(?:Draft Response|Suggested Response|Direct Answer|Solution|Answer)\*{0,2}:?\s*\n*)/i, '')
    .trimStart();
}

/**
 * Builds the complete prompt payload fusing conversation history, screen context, and knowledge.
 */
export function buildContextPrompt(
  query: string,
  mode: AssistantMode,
  recentTranscript: TranscriptItem[],
  knowledgePassages: string[] = []
): string {
  let prompt = '';

  if (recentTranscript && recentTranscript.length > 0) {
    prompt += '### RECENT CONVERSATION TRANSCRIPT\n';
    for (const item of recentTranscript.slice(-15)) {
      if (item.status !== 'ready' || !item.text || !item.text.trim()) continue;
      const speaker = item.role === 'me' ? 'You' : 'Remote Speaker';
      prompt += `[${speaker}]: ${item.text.trim()}\n`;
    }
    prompt += '\n';
  }

  if (knowledgePassages && knowledgePassages.length > 0) {
    prompt += '### RETRIEVED REFERENCE DOCUMENTS & NOTES\n';
    knowledgePassages.forEach((p, idx) => {
      prompt += `[Source ${idx + 1}]:\n${p}\n\n`;
    });
  }

  const defaultQuery =
    'Based on the screen and recent conversation, provide the next helpful answer or solution. Solve the questions displayed on screen directly. If fill-in-the-blank or missing-letter boxes (C-test) are visible, identify every box sequentially in reading order and output the exact missing letters to type along with the full word. Do NOT describe the screen context or write "Context:". Output only the direct solutions.';

  if (!query || !query.trim()) {
    prompt += `### USER REQUEST\n${defaultQuery}`;
  } else {
    prompt += `### USER REQUEST\n${query.trim()}\n(Provide only the direct solution/answer. If fill-in-the-blank/missing-letter boxes are shown, output every blank sequentially in reading order with the exact missing letters to type and the full word. Do NOT describe what is visible on screen or output "Context:" or "Draft Response:").`;
  }

  return prompt;
}

/**
 * Google Gemini streaming & non-streaming adapter.
 * Uses `x-goog-api-key` header to prevent credentials appearing in URL query strings or proxy logs.
 */
export async function streamGemini(options: GenerationOptions): Promise<string> {
  const { apiKey, mode, query, screenshotBase64, recentTranscript, knowledgePassages, conversationHistory, signal, onToken } = options;
  if (!apiKey || !apiKey.trim()) throw new Error('Gemini API key is required. Please configure it in Settings.');

  const modelName = assertModelCompatibleWithProvider(options.model, 'gemini');
  const systemInstruction = MODE_SYSTEM_PROMPTS[mode] || MODE_SYSTEM_PROMPTS.copilot;
  const textPrompt = buildContextPrompt(query, mode, recentTranscript, knowledgePassages);

  const parts: any[] = [{ text: textPrompt }];
  if (screenshotBase64) {
    const cleanB64 = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');
    parts.unshift({
      inlineData: {
        mimeType: 'image/png',
        data: cleanB64,
      },
    });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:streamGenerateContent?alt=sse`;
  validateNetworkEndpoint(endpoint);

  const contents: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
  if (conversationHistory && conversationHistory.length > 0) {
    for (const msg of conversationHistory) {
      if (!msg.content || !msg.content.trim()) continue;
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      });
    }
  }
  contents.push({ role: 'user', parts });

  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const bounded = createBoundedFetchController(signal, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey.trim(),
        },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: {
            // Omit deprecated sampling params (temperature/top_p/top_k) for Gemini 3.x / Gemini 4 v1beta compatibility
            maxOutputTokens: 1024,
          },
        }),
        signal: bounded.signal,
      });
    } catch (err: any) {
      if (bounded.didTimeout()) {
        throw new Error(`Gemini API request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }

    if (!response.ok) {
      const errorText = sanitizeProviderErrorBody(await response.text(), apiKey);
      if (response.status === 403 || response.status === 404) {
        if (options.model?.includes('2.5') || options.model?.includes('2.0') || errorText.includes('legacy') || errorText.includes('restricted')) {
          throw new Error(
            `Gemini API access error (${response.status}): Access to ${modelName} is restricted or deprecated. Please switch to "Gemini 3.5 Flash-Lite" or "Gemini 3.6 Flash" in Settings. Details: ${errorText}`
          );
        }
      }
      throw classifyHttpError('Gemini', response.status, errorText, modelName);
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
      const rawJson = await response.text();
      let parsed: any;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        throw new Error('Gemini API returned a malformed JSON response.');
      }
      const items = Array.isArray(parsed) ? parsed : [parsed];
      let combined = '';
      for (const item of items) {
        if (item?.error) {
          throw new Error(`Gemini API error: ${sanitizeProviderErrorBody(item.error.message || JSON.stringify(item.error), apiKey)}`);
        }
        const chunkText = item?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('') || '';
        if (chunkText) {
          combined += chunkText;
          onToken?.(chunkText);
        }
      }
      return cleanAssistantSolution(combined);
    }

    const rawText = await processSseStream(
      response,
      chunk => {
        const parsed = parseJsonOrThrowStreamError(chunk, 'Gemini', apiKey);
        if (parsed?.error) {
          throw new Error(`Gemini stream error: ${sanitizeProviderErrorBody(parsed.error.message || JSON.stringify(parsed.error), apiKey)}`);
        }
        return parsed?.candidates?.[0]?.content?.parts?.[0]?.text || null;
      },
      onToken,
      bounded.didTimeout,
      timeoutMs,
      'Gemini'
    );

    return cleanAssistantSolution(rawText);
  } finally {
    bounded.cleanup();
  }
}

/**
 * OpenAI GPT streaming & non-streaming adapter.
 */
export async function streamOpenAI(options: GenerationOptions): Promise<string> {
  const { apiKey, mode, query, screenshotBase64, recentTranscript, knowledgePassages, conversationHistory, signal, onToken } = options;
  if (!apiKey || !apiKey.trim()) throw new Error('OpenAI API key is required. Please configure it in Settings.');

  const modelName = assertModelCompatibleWithProvider(options.model, 'openai');
  const systemInstruction = MODE_SYSTEM_PROMPTS[mode] || MODE_SYSTEM_PROMPTS.copilot;
  const textPrompt = buildContextPrompt(query, mode, recentTranscript, knowledgePassages);

  const userContent: any[] = [{ type: 'text', text: textPrompt }];
  if (screenshotBase64) {
    const dataUrl = screenshotBase64.startsWith('data:')
      ? screenshotBase64
      : `data:image/png;base64,${screenshotBase64}`;
    userContent.push({
      type: 'image_url',
      image_url: { url: dataUrl, detail: 'high' },
    });
  }

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }> = [
    { role: 'system', content: systemInstruction },
  ];
  if (conversationHistory && conversationHistory.length > 0) {
    for (const msg of conversationHistory) {
      if (!msg.content || !msg.content.trim()) continue;
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
    }
  }
  messages.push({ role: 'user', content: userContent });

  const endpoint = 'https://api.openai.com/v1/chat/completions';
  validateNetworkEndpoint(endpoint);

  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const bounded = createBoundedFetchController(signal, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages,
          stream: true,
          temperature: 0.2,
          max_tokens: 2048,
        }),
        signal: bounded.signal,
      });
    } catch (err: any) {
      if (bounded.didTimeout()) {
        throw new Error(`OpenAI API request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }

    if (!response.ok) {
      const errorText = sanitizeProviderErrorBody(await response.text(), apiKey);
      if (response.status === 404 || (response.status === 400 && /model/i.test(errorText))) {
        throw new Error(
          `OpenAI API model error (${response.status}): Model "${modelName}" is unavailable or unsupported on your account. Details: ${errorText}`
        );
      }
      throw classifyHttpError('OpenAI', response.status, errorText, modelName);
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
      const rawJson = await response.text();
      let parsed: any;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        throw new Error('OpenAI API returned a malformed JSON response.');
      }
      if (parsed?.error) {
        throw new Error(`OpenAI API error: ${sanitizeProviderErrorBody(parsed.error.message || JSON.stringify(parsed.error), apiKey)}`);
      }
      const text = parsed?.choices?.[0]?.message?.content || '';
      if (text) onToken?.(text);
      return cleanAssistantSolution(text);
    }

    const rawText = await processSseStream(
      response,
      chunk => {
        const parsed = parseJsonOrThrowStreamError(chunk, 'OpenAI', apiKey);
        if (parsed?.error) {
          throw new Error(`OpenAI stream error: ${sanitizeProviderErrorBody(parsed.error.message || JSON.stringify(parsed.error), apiKey)}`);
        }
        return parsed?.choices?.[0]?.delta?.content || null;
      },
      onToken,
      bounded.didTimeout,
      timeoutMs,
      'OpenAI'
    );

    return cleanAssistantSolution(rawText);
  } finally {
    bounded.cleanup();
  }
}

/**
 * Anthropic Claude streaming & non-streaming adapter.
 */
export async function streamClaude(options: GenerationOptions): Promise<string> {
  const { apiKey, mode, query, screenshotBase64, recentTranscript, knowledgePassages, conversationHistory, signal, onToken } = options;
  if (!apiKey || !apiKey.trim()) throw new Error('Anthropic API key is required. Please configure it in Settings.');

  const modelName = assertModelCompatibleWithProvider(options.model, 'anthropic');
  const systemInstruction = MODE_SYSTEM_PROMPTS[mode] || MODE_SYSTEM_PROMPTS.copilot;
  const textPrompt = buildContextPrompt(query, mode, recentTranscript, knowledgePassages);

  const content: any[] = [];
  if (screenshotBase64) {
    const cleanB64 = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: cleanB64,
      },
    });
  }
  content.push({ type: 'text', text: textPrompt });

  const messages: Array<{ role: 'user' | 'assistant'; content: any }> = [];
  if (conversationHistory && conversationHistory.length > 0) {
    for (const msg of conversationHistory) {
      if (!msg.content || !msg.content.trim()) continue;
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
    }
  }
  messages.push({ role: 'user', content });

  const endpoint = 'https://api.anthropic.com/v1/messages';
  validateNetworkEndpoint(endpoint);

  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const bounded = createBoundedFetchController(signal, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey.trim(),
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model: modelName,
          max_tokens: 2048,
          system: systemInstruction,
          messages,
          stream: true,
        }),
        signal: bounded.signal,
      });
    } catch (err: any) {
      if (bounded.didTimeout()) {
        throw new Error(`Anthropic Claude API request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }

    if (!response.ok) {
      const errorText = sanitizeProviderErrorBody(await response.text(), apiKey);
      if (response.status === 400 || response.status === 404) {
        if (errorText.includes('model') || errorText.includes('not_found')) {
          throw new Error(
            `Anthropic API model error (${response.status}): Model "${modelName}" may be retired or unavailable on your account tier. Please check active Claude models in Settings. Details: ${errorText}`
          );
        }
      }
      throw classifyHttpError('Anthropic Claude', response.status, errorText, modelName);
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
      const rawJson = await response.text();
      let parsed: any;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        throw new Error('Anthropic Claude API returned a malformed JSON response.');
      }
      if (parsed?.type === 'error' || parsed?.error) {
        throw new Error(
          `Anthropic Claude API error: ${sanitizeProviderErrorBody(parsed.error?.message || JSON.stringify(parsed.error || parsed), apiKey)}`
        );
      }
      const text = Array.isArray(parsed?.content)
        ? parsed.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('')
        : '';
      if (text) onToken?.(text);
      return cleanAssistantSolution(text);
    }

    const rawText = await processSseStream(
      response,
      chunk => {
        const parsed = parseJsonOrThrowStreamError(chunk, 'Anthropic Claude', apiKey);
        if (parsed?.type === 'error' || parsed?.error) {
          throw new Error(
            `Anthropic Claude stream error: ${sanitizeProviderErrorBody(parsed.error?.message || JSON.stringify(parsed.error || parsed), apiKey)}`
          );
        }
        if (parsed?.type === 'content_block_delta') {
          return parsed.delta?.text || null;
        }
        return null;
      },
      onToken,
      bounded.didTimeout,
      timeoutMs,
      'Anthropic Claude'
    );

    return cleanAssistantSolution(rawText);
  } finally {
    bounded.cleanup();
  }
}

/**
 * Local Ollama streaming adapter (Offline).
 */
export async function streamOllama(options: GenerationOptions): Promise<string> {
  const { mode, query, screenshotBase64, recentTranscript, knowledgePassages, signal, onToken } = options;
  const systemInstruction = MODE_SYSTEM_PROMPTS[mode] || MODE_SYSTEM_PROMPTS.copilot;
  const textPrompt = buildContextPrompt(query, mode, recentTranscript, knowledgePassages);

  const images: string[] = [];
  if (screenshotBase64) {
    images.push(screenshotBase64.replace(/^data:image\/\w+;base64,/, ''));
  }

  const validated = assertModelCompatibleWithProvider(options.model, 'ollama');
  const modelName = validated !== 'ollama' ? validated : (images.length > 0 ? 'llava' : 'llama3.2');
  const endpoint = 'http://localhost:11434/api/generate';
  validateNetworkEndpoint(endpoint, true);

  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const bounded = createBoundedFetchController(signal, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          system: systemInstruction,
          prompt: textPrompt,
          images: images.length > 0 ? images : undefined,
          stream: true,
        }),
        signal: bounded.signal,
      });
    } catch (err: any) {
      if (bounded.didTimeout()) {
        throw new Error(`Ollama request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }

    if (!response.ok) {
      const errText = sanitizeProviderErrorBody(await response.text());
      if (response.status === 404 && errText.includes('not found')) {
        throw new Error(
          `Ollama model "${modelName}" is not installed yet. Open Dashboard -> Local AI & Hardware to download it with one click.`
        );
      }
      throw new Error(`Ollama connection error (${response.status}): Is Ollama running on localhost:11434? ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Failed to read Ollama stream');

    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';
    let validLineCount = 0;
    let invalidLineCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed: any;
          try {
            parsed = JSON.parse(line);
            validLineCount++;
          } catch {
            invalidLineCount++;
            continue;
          }
          if (parsed?.error) {
            throw new Error(`Ollama stream error: ${sanitizeProviderErrorBody(String(parsed.error))}`);
          }
          if (parsed?.response) {
            fullText += parsed.response;
            onToken?.(parsed.response);
          }
        }
      }
    } catch (err: any) {
      if (bounded.didTimeout()) {
        throw new Error(`Ollama stream timed out after ${timeoutMs}ms`);
      }
      throw err;
    }

    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        validLineCount++;
        if (parsed?.error) {
          throw new Error(`Ollama stream error: ${sanitizeProviderErrorBody(String(parsed.error))}`);
        }
        if (parsed?.response) {
          fullText += parsed.response;
          onToken?.(parsed.response);
        }
      } catch (err: any) {
        if (err instanceof Error && err.message.startsWith('Ollama stream error:')) throw err;
        invalidLineCount++;
      }
    }

    if (validLineCount === 0 && invalidLineCount > 0) {
      throw new Error('Ollama returned a malformed response stream.');
    }

    return cleanAssistantSolution(fullText);
  } finally {
    bounded.cleanup();
  }
}

function parseJsonOrThrowStreamError(chunk: string, providerLabel: string, apiKey?: string): any {
  try {
    return JSON.parse(chunk);
  } catch {
    throw new Error(`${providerLabel} stream returned malformed JSON payload: ${sanitizeProviderErrorBody(chunk, apiKey)}`);
  }
}

/**
 * Helper to process SSE streams from Gemini, OpenAI, Claude.
 */
async function processSseStream(
  response: Response,
  extractDelta: (data: string) => string | null,
  onToken?: (token: string) => void,
  didTimeout?: () => boolean,
  timeoutMs?: number,
  providerLabel: string = 'Provider'
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${providerLabel} returned an unreadable response body.`);

  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const dataStr = line.slice(5).trim();
    if (!dataStr || dataStr === '[DONE]') return;
    const delta = extractDelta(dataStr);
    if (delta) {
      fullText += delta;
      onToken?.(delta);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        handleLine(line.trimEnd());
      }
    }
  } catch (err: any) {
    if (didTimeout?.()) {
      throw new Error(`${providerLabel} stream timed out after ${timeoutMs}ms`);
    }
    throw err;
  }

  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      handleLine(line.trimEnd());
    }
  }

  return cleanAssistantSolution(fullText);
}

/**
 * Transcribes audio WAV using Groq Whisper (<300ms latency) or OpenAI Whisper.
 */
export async function transcribeAudio(
  wavBuffer: ArrayBuffer,
  apiKey: string,
  provider: 'groq' | 'openai' = 'groq',
  language: string = 'en',
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_STT_TIMEOUT_MS
): Promise<string> {
  if (!apiKey || !apiKey.trim()) {
    throw new Error(`${provider.toUpperCase()} API key is required for cloud speech transcription.`);
  }

  const endpoint =
    provider === 'groq'
      ? 'https://api.groq.com/openai/v1/audio/transcriptions'
      : 'https://api.openai.com/v1/audio/transcriptions';

  const model = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';
  validateNetworkEndpoint(endpoint);

  const formData = new FormData();
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  formData.append('file', blob, 'audio.wav');
  formData.append('model', model);
  formData.append('language', language);
  formData.append('response_format', 'json');

  const bounded = createBoundedFetchController(signal, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: formData,
        signal: bounded.signal,
      });
    } catch (err: any) {
      if (bounded.didTimeout()) {
        throw new Error(`STT API request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }

    if (!response.ok) {
      const errText = sanitizeProviderErrorBody(await response.text(), apiKey);
      throw classifyHttpError(`STT (${provider.toUpperCase()})`, response.status, errText, model);
    }

    const rawBody = await response.text();
    let result: any;
    try {
      result = JSON.parse(rawBody);
    } catch {
      throw new Error(`STT API (${provider.toUpperCase()}) returned a malformed JSON response.`);
    }

    if (typeof result?.text !== 'string') {
      throw new Error(`STT API (${provider.toUpperCase()}) returned an unexpected payload without transcript text.`);
    }

    return result.text.trim();
  } finally {
    bounded.cleanup();
  }
}
