import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUserSettingsPromptBlock,
  normalizeGeminiModel,
  parseModelJsonObject,
  parseTailoringPayload,
  validateGeminiApiKey
} from '../cover-letter-ai.js';
import { DEFAULT_GEMINI_MODEL } from '../constants.js';

test('parseModelJsonObject extracts JSON candidate from fenced response', () => {
  const raw = 'before\n```json\n{"recommendation":"Focus on systems","operations":[]}\n```\nafter';
  const parsed = parseModelJsonObject(raw);

  assert.equal(parsed.recommendation, 'Focus on systems');
  assert.deepEqual(parsed.operations, []);
});

test('parseModelJsonObject throws actionable parse error for non-JSON text', () => {
  assert.throws(
    () => parseModelJsonObject('Sure, here are improvements in plain English.'),
    error => {
      assert.equal(error instanceof Error, true);
      assert.match(error.message, /not valid JSON/i);
      assert.equal(typeof error.debugInfo?.responseLength, 'number');
      return true;
    }
  );
});

test('parseTailoringPayload normalizes recommendation and operations', () => {
  const payload = parseTailoringPayload('{"recommendation":"Add Kubernetes impact","operations":[{"type":"REDLINE","targetRef":"P4","target":"x","modified":"y"}]}');

  assert.equal(payload.recommendation, 'Add Kubernetes impact');
  assert.equal(payload.operations.length, 1);
  assert.equal(payload.operations[0].type, 'redline');
});

test('buildUserSettingsPromptBlock includes voice and extra guidance', () => {
  const block = buildUserSettingsPromptBlock({
    voice: 'Confident and concise',
    extraGuidance: 'Keep opening paragraph short.'
  });

  assert.match(block, /Voice\/style target/i);
  assert.match(block, /Keep opening paragraph short/i);
});

test('normalizeGeminiModel keeps supported values and falls back for unknown values', () => {
  assert.equal(normalizeGeminiModel('gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(normalizeGeminiModel('unknown'), DEFAULT_GEMINI_MODEL);
});

test('validateGeminiApiKey performs a lightweight Gemini API call', async () => {
  let capturedUrl = '';
  let capturedMethod = '';
  const fetchFn = async (url, init = {}) => {
    capturedUrl = String(url || '');
    capturedMethod = String(init?.method || '');
    return {
      ok: true,
      async json() {
        return {
          models: [
            { name: 'models/gemini-2.5-flash' },
            { name: 'models/gemini-2.5-pro' }
          ]
        };
      }
    };
  };

  const result = await validateGeminiApiKey({
    apiKey: 'AIza-test-key',
    model: 'gemini-2.5-pro',
    fetchFn
  });

  assert.equal(result.model, 'gemini-2.5-pro');
  assert.equal(result.selectedModelAvailable, true);
  assert.equal(result.availableModelCount, 2);
  assert.equal(capturedMethod, 'GET');
  assert.match(capturedUrl, /\/v1beta\/models\?key=AIza-test-key/i);
});

test('validateGeminiApiKey retries transient 503 responses before succeeding', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        async text() {
          return 'temporarily unavailable';
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { models: [{ name: 'models/gemini-2.5-pro' }] };
      }
    };
  };

  const result = await validateGeminiApiKey({
    apiKey: 'AIza-test-key',
    model: 'gemini-2.5-pro',
    fetchFn
  });

  assert.equal(calls, 2);
  assert.equal(result.model, 'gemini-2.5-pro');
  assert.equal(result.selectedModelAvailable, true);
});
