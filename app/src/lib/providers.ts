import { AssistantMode, ChatMessage, TranscriptItem } from './types';

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
  onToken?: (token: string) => void;
}

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
 * Strips verbose screen context descriptions and meta headers from model responses.
 * Ensures the user receives only direct answers and solutions without preambles like:
 * "Context: The visible screen shows..." or "Draft Response:".
 */
export function cleanAssistantSolution(text: string): string {
  if (!text) return text;

  // 1. Check if the response begins with a Context block (plain, markdown bold/header, bulleted, or list)
  // e.g. "Context: The visible screen shows...\nDraft Response:\n..."
  // e.g. "• Context: ... \n• Draft Response:\n..."
  // e.g. "**Context:** ... \n\n[Solution]"
  const contextBlockMatch = text.match(
    /^[\s*•\-#]*(\*{0,2}(?:Context|Screen Context|Screen Analysis|Visible Screen)\*{0,2}:?[\s\S]*?)(?:\n\s*[\s*•\-#]*\*{0,2}(?:Draft Response|Response|Suggested Response|Solution|Answer|Suggested Answer)\*{0,2}:?|\n{2,}|$)/i
  );

  if (contextBlockMatch) {
    // If the entire text so far is just the incomplete context line without a delimiter, hide it during streaming
    if (contextBlockMatch[0].length === text.length && !text.includes('\n\n') && !/\b(?:response|answer|solution):/i.test(text)) {
      return '';
    }
    const matchedPrefix = contextBlockMatch[0];
    const remainder = text
      .slice(matchedPrefix.length)
      .replace(/^[\s*•\-#]*(\*{0,2}(?:Draft Response|Response|Suggested Response|Solution|Answer|Suggested Answer)\*{0,2}:?\s*\n*)/i, '');
    return remainder.trimStart();
  }

  // 2. Strip standalone leading "Draft Response:", "Suggested Response:", bulleted or plain
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

  // 1. Conversation transcript context
  if (recentTranscript && recentTranscript.length > 0) {
    prompt += '### RECENT CONVERSATION TRANSCRIPT\n';
    for (const item of recentTranscript.slice(-15)) {
      // Only include completed, verified transcript items (skip transcribing placeholders and errors)
      if (item.status !== 'ready' || !item.text || !item.text.trim()) continue;
      const speaker = item.role === 'me' ? 'You' : 'Remote Speaker';
      prompt += `[${speaker}]: ${item.text.trim()}\n`;
    }
    prompt += '\n';
  }

  // 2. Personal knowledge context
  if (knowledgePassages && knowledgePassages.length > 0) {
    prompt += '### RETRIEVED REFERENCE DOCUMENTS & NOTES\n';
    knowledgePassages.forEach((p, idx) => {
      prompt += `[Source ${idx + 1}]:\n${p}\n\n`;
    });
  }

  // 3. User request
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
 * Google Gemini 2.5 streaming adapter.
 * Uses `x-goog-api-key` header to prevent credentials appearing in URL query strings or proxy logs.
 */
export async function streamGemini(options: GenerationOptions): Promise<string> {
  const { apiKey, mode, query, screenshotBase64, recentTranscript, knowledgePassages, conversationHistory, signal, onToken } = options;
  if (!apiKey) throw new Error('Gemini API key is required. Please configure it in Settings.');

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

  // Prefer active 2026 models: Default to ultra-fast sub-second gemini-3.5-flash-lite
  let modelName = options.model?.startsWith('gemini') ? options.model : 'gemini-3.5-flash-lite';
  if (modelName === 'gemini-2.5-flash') {
    modelName = 'gemini-3.5-flash-lite';
  }

  let endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:streamGenerateContent?alt=sse`;
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

  let response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey.trim(), // Header-based auth avoids credential exposure in URL
    },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
      },
    }),
    signal,
  });

  // Never substitute a different model after an authorization or model-not-found error.
  // The selected model is part of the user's configuration and must remain observable.

  if (!response.ok) {
    // Graceful automatic recovery: if a model encounters a temporary 503 high-demand spike, failover to sub-second flash-lite
    if (response.status === 503 && modelName !== 'gemini-3.5-flash-lite') {
      console.warn(`[streamGemini] ${modelName} returned 503 high-demand spike. Falling back to sub-second gemini-3.5-flash-lite.`);
      return streamGemini({ ...options, model: 'gemini-3.5-flash-lite' });
    }

    const errorText = await response.text();
    if (response.status === 403 || response.status === 404) {
      if (options.model?.includes('2.5') || modelName.includes('2.5') || errorText.includes('legacy') || errorText.includes('restricted')) {
        throw new Error(
          `Gemini API access error (${response.status}): Access to ${options.model || modelName} is restricted to legacy projects. Please switch to "Gemini 3.5 Flash-Lite" (or "Gemini 3.8 Flash") in Settings. Details: ${errorText}`
        );
      }
    }
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const rawText = await processSseStream(response, chunk => {
    try {
      const parsed = JSON.parse(chunk);
      return parsed.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch {
      return null;
    }
  }, onToken);

  return cleanAssistantSolution(rawText);
}

/**
 * OpenAI GPT-4o / GPT-4o-mini streaming adapter.
 */
export async function streamOpenAI(options: GenerationOptions): Promise<string> {
  const { apiKey, mode, query, screenshotBase64, recentTranscript, knowledgePassages, conversationHistory, signal, onToken } = options;
  if (!apiKey) throw new Error('OpenAI API key is required. Please configure it in Settings.');

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

  const modelName = options.model?.startsWith('gpt-') ? options.model : 'gpt-4o';
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
  const response = await fetch(endpoint, {
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
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }

  const rawText = await processSseStream(response, chunk => {
    try {
      const parsed = JSON.parse(chunk);
      return parsed.choices?.[0]?.delta?.content || null;
    } catch {
      return null;
    }
  }, onToken);

  return cleanAssistantSolution(rawText);
}

/**
 * Anthropic Claude streaming adapter.
 */
export async function streamClaude(options: GenerationOptions): Promise<string> {
  const { apiKey, mode, query, screenshotBase64, recentTranscript, knowledgePassages, conversationHistory, signal, onToken } = options;
  if (!apiKey) throw new Error('Anthropic API key is required. Please configure it in Settings.');

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

  let modelName = 'claude-sonnet-5';
  if (options.model === 'claude-haiku-4-5-20251001' || options.model === 'claude-haiku-5-5') {
    modelName = 'claude-haiku-4-5-20251001';
  } else if (options.model === 'claude-opus-5' || options.model === 'claude-opus-5-5') {
    modelName = 'claude-opus-5';
  } else if (options.model === 'claude-sonnet-5' || options.model === 'claude-sonnet-5-5') {
    modelName = 'claude-sonnet-5';
  } else if (options.model?.startsWith('claude-')) {
    modelName = options.model;
  }

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
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey.trim(),
      'anthropic-version': '2026-10-21',
    },
    body: JSON.stringify({
      model: modelName,
      max_tokens: 2048,
      system: systemInstruction,
      messages,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 400 || response.status === 404) {
      if (errorText.includes('model') || errorText.includes('not_found')) {
        throw new Error(
          `Anthropic API model error (${response.status}): Model "${modelName}" may be retired or unavailable on your account tier. Please check active Claude models in Settings. Details: ${errorText}`
        );
      }
    }
    throw new Error(`Anthropic Claude API error (${response.status}): ${errorText}`);
  }

  const rawText = await processSseStream(response, chunk => {
    try {
      const parsed = JSON.parse(chunk);
      if (parsed.type === 'content_block_delta') {
        return parsed.delta?.text || null;
      }
      return null;
    } catch {
      return null;
    }
  }, onToken);

  return cleanAssistantSolution(rawText);
}

/**
 * Local Ollama streaming adapter (Offline).
 */
export async function streamOllama(options: GenerationOptions): Promise<string> {
  const { mode, query, screenshotBase64, recentTranscript, knowledgePassages, conversationHistory, signal, onToken } = options;
  const systemInstruction = MODE_SYSTEM_PROMPTS[mode] || MODE_SYSTEM_PROMPTS.copilot;
  const textPrompt = buildContextPrompt(query, mode, recentTranscript, knowledgePassages);

  const images: string[] = [];
  if (screenshotBase64) {
    images.push(screenshotBase64.replace(/^data:image\/\w+;base64,/, ''));
  }

  const modelName = options.model && options.model !== 'ollama' ? options.model : (images.length > 0 ? 'llava' : 'llama3.2');
  const endpoint = 'http://localhost:11434/api/generate';
  validateNetworkEndpoint(endpoint, true);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      system: systemInstruction,
      prompt: textPrompt,
      images: images.length > 0 ? images : undefined,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.response) {
          fullText += parsed.response;
          onToken?.(parsed.response);
        }
      } catch { }
    }
  }

  // Flush any trailing JSON in buffer
  if (buffer.trim()) {
    try {
      const parsed = JSON.parse(buffer.trim());
      if (parsed.response) {
        fullText += parsed.response;
        onToken?.(parsed.response);
      }
    } catch { }
  }

  return cleanAssistantSolution(fullText);
}

/**
 * Helper to process SSE streams from Gemini, OpenAI, Claude
 */
async function processSseStream(
  response: Response,
  extractDelta: (data: string) => string | null,
  onToken?: (token: string) => void
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Failed to obtain streaming reader');

  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        const delta = extractDelta(dataStr);
        if (delta) {
          fullText += delta;
          onToken?.(delta);
        }
      }
    }
  }

  // Flush any trailing SSE chunk in buffer
  if (buffer.trim()) {
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const dataStr = line.slice(6).trim();
        if (dataStr && dataStr !== '[DONE]') {
          const delta = extractDelta(dataStr);
          if (delta) {
            fullText += delta;
            onToken?.(delta);
          }
        }
      }
    }
  }

  return cleanAssistantSolution(fullText);
}

/**
 * Transcribes audio WAV using Groq Whisper (<300ms latency) or OpenAI Whisper
 */
export async function transcribeAudio(
  wavBuffer: ArrayBuffer,
  apiKey: string,
  provider: 'groq' | 'openai' = 'groq',
  language: string = 'en',
  signal?: AbortSignal
): Promise<string> {
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

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: formData,
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`STT API error (${response.status}): ${errText}`);
  }

  const result = await response.json();
  return result.text?.trim() || '';
}
