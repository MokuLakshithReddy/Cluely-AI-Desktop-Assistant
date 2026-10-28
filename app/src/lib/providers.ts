import { AssistantMode, ChatMessage, TranscriptItem } from './types';

export interface GenerationOptions {
  model: string;
  apiKey?: string;
  mode: AssistantMode;
  query: string;
  screenshotBase64?: string;
  recentTranscript: TranscriptItem[];
  knowledgePassages?: string[];
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

export const MODE_SYSTEM_PROMPTS: Record<AssistantMode, string> = {
  copilot: `You are an expert personal desktop copilot running alongside the user's active applications.
Provide direct, concise, and highly relevant assistance.
Ground your answers strictly on the visible screen context, recent live conversation transcripts, and supplied notes.
If there is not enough context to answer accurately, explicitly state what is missing instead of fabricating facts.
Format code snippets in clear markdown blocks with language annotations.`,

  interview: `You are a discreet, world-class technical interview copilot.
Your user is in a live coding interview or technical evaluation.
Listen to the conversation transcript and inspect the problem on screen:
1. Provide the optimal algorithm name, time complexity O(...) and space complexity O(...).
2. Give a concise high-level approach in 2-3 bullet points.
3. Provide clean, bug-free implementation code.
4. Supply 2 key talking points the user can naturally say aloud to the interviewer.
Be extremely succinct and scannable. Do not provide unnecessary conversational filler.`,

  coding: `You are an elite software engineering copilot and debugger.
Analyze code snippets, terminal outputs, stack traces, and compiler errors on screen.
Identify the root cause immediately and provide the exact diff or fix.
Explain why the issue occurred in one concise sentence.`,

  sales: `You are a strategic live sales and negotiation copilot.
Listen to the client's questions and objections in the conversation transcript:
1. Identify the core objection or underlying concern.
2. Provide a 2-sentence conversational response using proven objection-handling frameworks (Feel-Felt-Found, Question-Before-Answer).
3. Suggest a closing or qualifying follow-up question.`,

  executive: `You are an executive chief of staff and meeting intelligence copilot.
Summarize the discussion on screen and in the transcript:
1. Core decisions made.
2. Action items with assignees if mentioned.
3. Unresolved questions and immediate next steps.`
};

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
  if (recentTranscript.length > 0) {
    prompt += '### RECENT CONVERSATION TRANSCRIPT\n';
    for (const item of recentTranscript.slice(-12)) {
      const speaker = item.role === 'me' ? 'You' : 'Remote Speaker';
      prompt += `[${speaker}]: ${item.text}\n`;
    }
    prompt += '\n';
  }

  // 2. Personal knowledge context
  if (knowledgePassages.length > 0) {
    prompt += '### RETRIEVED REFERENCE DOCUMENTS & NOTES\n';
    knowledgePassages.forEach((p, idx) => {
      prompt += `[Source ${idx + 1}]:\n${p}\n\n`;
    });
  }

  // 3. User request
  prompt += `### USER REQUEST\n${query || 'Based on the screen and recent conversation, provide the next helpful answer or solution.'}`;

  return prompt;
}

/**
 * Calls Google Gemini (Gemini 2.5 Flash / 1.5 Flash) with multimodal vision and streaming
 */
export async function streamGemini(options: GenerationOptions): Promise<string> {
  const { apiKey, mode, query, screenshotBase64, recentTranscript, knowledgePassages, signal, onToken } = options;
  if (!apiKey) throw new Error('Gemini API key is required. Please set it in Settings.');

  const systemInstruction = MODE_SYSTEM_PROMPTS[mode];
  const textPrompt = buildContextPrompt(query, mode, recentTranscript, knowledgePassages);

  const parts: any[] = [{ text: textPrompt }];
  if (screenshotBase64) {
    // Strip header if present
    const cleanB64 = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');
    parts.unshift({
      inlineData: {
        mimeType: 'image/png',
        data: cleanB64,
      },
    });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${apiKey}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
      },
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Failed to obtain streaming reader from Gemini');

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
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const chunkText = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (chunkText) {
            fullText += chunkText;
            onToken?.(chunkText);
          }
        } catch {
          // Ignore incomplete chunk parse errors
        }
      }
    }
  }

  return fullText;
}

/**
 * Calls OpenAI GPT-4o with multimodal vision and streaming
 */
export async function streamOpenAI(options: GenerationOptions): Promise<string> {
  const { apiKey, mode, query, screenshotBase64, recentTranscript, knowledgePassages, signal, onToken } = options;
  if (!apiKey) throw new Error('OpenAI API key is required. Please set it in Settings.');

  const systemInstruction = MODE_SYSTEM_PROMPTS[mode];
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

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userContent },
      ],
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

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Failed to obtain streaming reader from OpenAI');

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
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            onToken?.(delta);
          }
        } catch {
          // Ignore incomplete chunk parse errors
        }
      }
    }
  }

  return fullText;
}

/**
 * Transcribes audio WAV using Groq Whisper (<300ms latency) or OpenAI Whisper
 */
export async function transcribeAudio(
  wavBuffer: ArrayBuffer,
  apiKey: string,
  provider: 'groq' | 'openai' = 'groq',
  language: string = 'en'
): Promise<string> {
  const endpoint =
    provider === 'groq'
      ? 'https://api.groq.com/openai/v1/audio/transcriptions'
      : 'https://api.openai.com/v1/audio/transcriptions';

  const model = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';

  const formData = new FormData();
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  formData.append('file', blob, 'audio.wav');
  formData.append('model', model);
  formData.append('language', language);
  formData.append('response_format', 'json');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`STT API error (${response.status}): ${errText}`);
  }

  const result = await response.json();
  return result.text?.trim() || '';
}

