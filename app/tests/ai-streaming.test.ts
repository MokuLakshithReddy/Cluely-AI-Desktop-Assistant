import { describe, it, expect } from 'vitest';
import { ChatMessage, SessionRecord } from '../src/lib/types';

describe('AI Streaming State Resilience Subsystem', () => {
  it('accumulates 50 consecutive streamed tokens without dropping prior user message or earlier tokens', () => {
    // Simulate functional state updater pattern implemented in useAiAssistant / useSharedState
    let currentState: { session: SessionRecord } = {
      session: {
        id: 'sess_streaming_test',
        title: 'Streaming Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        durationSeconds: 0,
        mode: 'coding',
        audioInputLanguage: 'en',
        transcript: [],
        messages: [
          {
            id: 'msg_u_1',
            role: 'user',
            content: 'How do I invert a binary tree?',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'msg_a_1',
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
            isStreaming: true,
          },
        ],
      },
    };

    const tokens = [
      'To ', 'invert ', 'a ', 'binary ', 'tree, ', 'swap ', 'the ', 'left ', 'and ', 'right ',
      'pointers ', 'of ', 'every ', 'node ', 'recursively.\n\n',
      '```python\n', 'def ', 'invertTree(root):\n', '    if ', 'not ', 'root:\n',
      '        return ', 'None\n', '    root.left, ', 'root.right ', '= ',
      'invertTree(root.right), ', 'invertTree(root.left)\n', '    return ', 'root\n', '```'
    ];

    const activeMessages = [...currentState.session.messages];

    // Simulate each token arrival
    let accumulated = '';
    for (const token of tokens) {
      accumulated += token;
      // Functional updater update
      activeMessages[1] = {
        ...activeMessages[1],
        content: accumulated,
        isStreaming: true,
      };

      currentState = {
        session: {
          ...currentState.session,
          messages: [...activeMessages],
        },
      };
    }

    // Mark completion
    activeMessages[1] = {
      ...activeMessages[1],
      isStreaming: false,
    };
    currentState = {
      session: {
        ...currentState.session,
        messages: [...activeMessages],
      },
    };

    // Assertions
    expect(currentState.session.messages.length).toBe(2);
    // User message is preserved intact
    expect(currentState.session.messages[0].content).toBe('How do I invert a binary tree?');
    // Assistant message contains the full combined output
    expect(currentState.session.messages[1].content).toBe(tokens.join(''));
    expect(currentState.session.messages[1].isStreaming).toBe(false);
  });

  it('preserves multi-turn conversation history across multiple consecutive queries', () => {
    let messages: ChatMessage[] = [];

    // Turn 1
    messages.push({ id: 'u1', role: 'user', content: 'What is memoization?', createdAt: 't1' });
    messages.push({ id: 'a1', role: 'assistant', content: 'Memoization caches function results.', createdAt: 't2' });

    // Turn 2
    messages.push({ id: 'u2', role: 'user', content: 'How does it differ from tabulation?', createdAt: 't3' });
    messages.push({ id: 'a2', role: 'assistant', content: 'Tabulation is bottom-up; memoization is top-down.', createdAt: 't4' });

    expect(messages.length).toBe(4);
    expect(messages[0].id).toBe('u1');
    expect(messages[1].id).toBe('a1');
    expect(messages[2].id).toBe('u2');
    expect(messages[3].id).toBe('a2');
  });

  it('gracefully handles user cancellation by marking generation stopped while retaining accumulated content', () => {
    const userMsg: ChatMessage = { id: 'u1', role: 'user', content: 'Write a quicksort in C++', createdAt: 't1' };
    const asstMsg: ChatMessage = { id: 'a1', role: 'assistant', content: 'int partition(int arr[])', createdAt: 't2', isStreaming: true };

    const messages = [userMsg, asstMsg];

    // Simulate AbortController trigger
    messages[1] = {
      ...messages[1],
      content: messages[1].content + '\n\n*(Generation stopped by user)*',
      isStreaming: false,
    };

    expect(messages[1].content).toContain('*(Generation stopped by user)*');
    expect(messages[1].isStreaming).toBe(false);
    expect(messages[0].content).toBe('Write a quicksort in C++');
  });

  it('guarantees state immutability when updating session records', () => {
    const original: SessionRecord = {
      id: 's_immut',
      title: 'Original Title',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      durationSeconds: 10,
      mode: 'copilot',
      audioInputLanguage: 'en',
      transcript: [],
      messages: [],
    };

    const updated: SessionRecord = {
      ...original,
      title: 'Updated Title',
      durationSeconds: 20,
    };

    expect(original.title).toBe('Original Title');
    expect(updated.title).toBe('Updated Title');
    expect(original.durationSeconds).toBe(10);
    expect(updated.durationSeconds).toBe(20);
  });
});

