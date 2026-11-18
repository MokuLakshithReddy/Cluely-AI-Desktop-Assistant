#!/usr/bin/env node
'use strict';

/**
 * Live AI Provider Smoke Verification Runner (Real Network & Real Credentials Only)
 *
 * Distinct from mocked unit tests in `app/tests/provider-models.test.ts`.
 * Calls the actual compiled `app/dist-electron/src/lib/providers.js` adapters
 * against live provider HTTPS endpoints for every configured credential in process.env.
 *
 * Usage:
 *   GEMINI_API_KEY=... OPENAI_API_KEY=... ANTHROPIC_API_KEY=... node app/scripts/verify-live-providers.cjs
 */

const path = require('node:path');

const providersMod = require(path.resolve(__dirname, '..', 'dist-electron', 'src', 'lib', 'providers.js'));
const { streamGemini, streamOpenAI, streamClaude } = providersMod;

async function main() {
  const checks = [];

  if (process.env.GEMINI_API_KEY?.trim()) {
    for (const model of ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-4-hydrogen']) {
      checks.push({
        label: `Gemini live (${model})`,
        run: () => streamGemini({
          model,
          apiKey: process.env.GEMINI_API_KEY.trim(),
          mode: 'copilot',
          query: 'Reply with exactly the single word: OK',
          recentTranscript: [],
          timeoutMs: 20000,
        }),
      });
    }
  }

  if (process.env.OPENAI_API_KEY?.trim()) {
    for (const model of ['gpt-4o-mini', 'gpt-4.1-mini']) {
      checks.push({
        label: `OpenAI live (${model})`,
        run: () => streamOpenAI({
          model,
          apiKey: process.env.OPENAI_API_KEY.trim(),
          mode: 'copilot',
          query: 'Reply with exactly the single word: OK',
          recentTranscript: [],
          timeoutMs: 20000,
        }),
      });
    }
  }

  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5']) {
      checks.push({
        label: `Anthropic live (${model})`,
        run: () => streamClaude({
          model,
          apiKey: process.env.ANTHROPIC_API_KEY.trim(),
          mode: 'copilot',
          query: 'Reply with exactly the single word: OK',
          recentTranscript: [],
          timeoutMs: 20000,
        }),
      });
    }
  }

  if (checks.length === 0) {
    console.error(
      'No live provider API keys found in environment (GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY). ' +
      'Refusing to claim live provider verification without real credentials.'
    );
    process.exit(2);
  }

  let failures = 0;
  for (const check of checks) {
    const t0 = Date.now();
    try {
      const output = await check.run();
      if (!output || !output.trim()) {
        throw new Error('Empty response received from live provider');
      }
      console.log(`PASS  ${check.label} (${Date.now() - t0}ms): ${output.trim().slice(0, 60)}`);
    } catch (err) {
      failures++;
      console.error(`FAIL  ${check.label} (${Date.now() - t0}ms): ${err?.message || String(err)}`);
    }
  }

  if (failures > 0) {
    console.error(`Live provider verification finished with ${failures}/${checks.length} failure(s).`);
    process.exit(1);
  }
  console.log(`Live provider verification PASSED (${checks.length}/${checks.length}).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
