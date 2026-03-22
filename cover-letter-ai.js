import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODEL_OPTIONS,
  MAX_BASE_LETTER_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_JOB_DESCRIPTION_CHARS,
  REDLINE_CAP
} from './constants.js';

function extractJsonCandidateBlocks(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return [];

  const candidates = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch = null;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    if (fenceMatch[1]?.trim()) {
      candidates.push(fenceMatch[1].trim());
    }
  }

  candidates.push(text);

  const firstObj = text.indexOf('{');
  const lastObj = text.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) {
    candidates.push(text.slice(firstObj, lastObj + 1).trim());
  }

  const firstArr = text.indexOf('[');
  const lastArr = text.lastIndexOf(']');
  if (firstArr >= 0 && lastArr > firstArr) {
    candidates.push(text.slice(firstArr, lastArr + 1).trim());
  }

  return candidates;
}

function buildModelResponsePreview(rawText) {
  const normalized = String(rawText || '').replace(/\s+/g, ' ').trim();
  return normalized
    ? (normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized)
    : '(empty response)';
}

function countPatternMatches(text, pattern) {
  return (String(text || '').match(pattern) || []).length;
}

function buildResponseShapeDebugInfo(rawText) {
  const text = String(rawText || '');
  const trimmed = text.trim();
  const hasCodeFence = /```(?:json)?/i.test(text);
  const hasClosingFence = countPatternMatches(text, /```/g) >= 2;
  const openBraceCount = countPatternMatches(text, /\{/g);
  const closeBraceCount = countPatternMatches(text, /\}/g);
  const openBracketCount = countPatternMatches(text, /\[/g);
  const closeBracketCount = countPatternMatches(text, /\]/g);
  const endsWithComma = /,\s*$/.test(trimmed);
  const endsWithOpenBracket = /\[\s*$/.test(trimmed);
  const endsWithOpenBrace = /\{\s*$/.test(trimmed);
  const looksTruncated = Boolean(
    (hasCodeFence && !hasClosingFence)
    || endsWithComma
    || endsWithOpenBracket
    || endsWithOpenBrace
    || openBraceCount > closeBraceCount
    || openBracketCount > closeBracketCount
  );

  return {
    hasCodeFence,
    hasClosingFence,
    endsWithComma,
    endsWithOpenBracket,
    endsWithOpenBrace,
    openBraceCount,
    closeBraceCount,
    openBracketCount,
    closeBracketCount,
    looksTruncated
  };
}

function getPartKind(part) {
  if (!part || typeof part !== 'object') return 'unknown';
  if (typeof part.text === 'string') return 'text';

  const keys = Object.keys(part);
  return keys[0] || 'unknown';
}

function buildGeminiDebugInfo(payload, text, context = {}) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const firstCandidate = candidates[0] || {};
  const parts = Array.isArray(firstCandidate?.content?.parts) ? firstCandidate.content.parts : [];
  const responsePreview = buildModelResponsePreview(text);

  return {
    stage: String(context?.stage || '').trim() || 'unknown',
    model: String(context?.model || '').trim() || 'unknown',
    candidateCount: candidates.length,
    finishReason: String(firstCandidate?.finishReason || '').trim() || 'unknown',
    blockReason: String(payload?.promptFeedback?.blockReason || '').trim() || '',
    partCount: parts.length,
    textPartCount: parts.filter(part => typeof part?.text === 'string' && part.text.trim()).length,
    partKinds: parts.slice(0, 5).map(getPartKind),
    promptTokenCount: Number(payload?.usageMetadata?.promptTokenCount || 0),
    candidatesTokenCount: Number(payload?.usageMetadata?.candidatesTokenCount || 0),
    totalTokenCount: Number(payload?.usageMetadata?.totalTokenCount || 0),
    responseLength: String(text || '').length,
    responsePreview,
    ...buildResponseShapeDebugInfo(text)
  };
}

function attachDebugInfo(error, debugInfo) {
  if (!error || typeof error !== 'object' || !debugInfo) return error;
  error.debugInfo = {
    ...(error.debugInfo && typeof error.debugInfo === 'object' ? error.debugInfo : {}),
    ...debugInfo
  };
  return error;
}

function buildModelJsonParseError(rawText, context = {}) {
  const preview = buildModelResponsePreview(rawText);
  const responseShape = buildResponseShapeDebugInfo(rawText);
  const apiDebugInfo = context?.apiDebugInfo && typeof context.apiDebugInfo === 'object'
    ? context.apiDebugInfo
    : {};

  const error = new Error(
    `Model response was not valid JSON. Try again. Response preview: ${preview}`
  );
  error.debugInfo = {
    stage: String(context?.stage || '').trim() || 'unknown',
    model: String(context?.model || '').trim() || 'unknown',
    ...apiDebugInfo,
    responseLength: String(rawText || '').length,
    responsePreview: preview,
    ...responseShape
  };
  return error;
}

function normalizeOperation(rawOp) {
  const op = rawOp && typeof rawOp === 'object' ? rawOp : {};
  return {
    type: String(op.type || '').trim().toLowerCase(),
    targetRef: op.targetRef ?? null,
    targetEndRef: op.targetEndRef ?? null,
    target: String(op.target || ''),
    textToComment: String(op.textToComment || ''),
    commentContent: String(op.commentContent || ''),
    textToHighlight: String(op.textToHighlight || ''),
    color: String(op.color || ''),
    modified: String(op.modified || '')
  };
}

export function parseModelJsonObject(rawText, context = {}) {
  const candidates = extractJsonCandidateBlocks(rawText);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next candidate.
    }
  }
  throw buildModelJsonParseError(rawText, context);
}

export function parseTailoringPayload(rawText, context = {}) {
  const parsed = parseModelJsonObject(rawText, context);
  const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};

  return {
    recommendation: String(payload.recommendation || '').trim(),
    inferredCompany: String(payload.inferredCompany || '').trim(),
    inferredRole: String(payload.inferredRole || '').trim(),
    operations: Array.isArray(payload.operations) ? payload.operations.map(normalizeOperation) : []
  };
}

export function normalizeGeminiModel(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return DEFAULT_GEMINI_MODEL;
  const supported = GEMINI_MODEL_OPTIONS.find(option => option.value === candidate);
  return supported ? supported.value : DEFAULT_GEMINI_MODEL;
}

export async function validateGeminiApiKey({
  apiKey,
  model,
  fetchFn = fetch
}) {
  const normalizedKey = String(apiKey || '').trim();
  if (!normalizedKey) {
    throw new Error('Enter a Gemini API key first.');
  }

  const resolvedModel = normalizeGeminiModel(model);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(normalizedKey)}&pageSize=200`;
  const response = await fetchFn(endpoint, {
    method: 'GET'
  });

  if (!response.ok) {
    const text = await response.text();
    throw attachDebugInfo(
      new Error(`Gemini API ${response.status}: ${text.slice(0, 500)}`),
      {
        stage: 'api-key-validation',
        model: resolvedModel,
        httpStatus: response.status,
        responseLength: String(text || '').length,
        responsePreview: buildModelResponsePreview(text),
        ...buildResponseShapeDebugInfo(text)
      }
    );
  }

  const payload = await response.json();
  const availableModels = (Array.isArray(payload?.models) ? payload.models : [])
    .map(entry => String(entry?.name || '').replace(/^models\//i, '').trim())
    .filter(Boolean);
  const selectedModelAvailable = availableModels.length === 0
    ? true
    : availableModels.includes(resolvedModel);

  return {
    model: resolvedModel,
    selectedModelAvailable,
    availableModelCount: availableModels.length
  };
}

export function buildUserSettingsPromptBlock(settings = {}) {
  const voice = String(settings?.voice || '').trim();
  const extraGuidance = String(settings?.extraGuidance || '').trim();

  if (!voice && !extraGuidance) return '';

  const lines = ['Additional user prompt guidance:'];
  if (voice) lines.push(`- Voice/style target: ${voice}`);
  if (extraGuidance) lines.push(`- Extra guidance: ${extraGuidance}`);
  return lines.join('\n');
}

function buildTodayDateText(now = new Date()) {
  const monthDayYear = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(now);
  const iso = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
  return `${monthDayYear} (${iso})`;
}

function buildSystemPrompt({
  mode,
  redlineCap,
  promptSettings,
  targetDocumentLabel,
  todayDateText = '',
  shouldUpdateDateLine = false
}) {
  const modeInstruction = mode === 'track'
    ? 'Track Changes mode is ON. Prefer redline operations for substantive rewrites and comments for rationale when useful.'
    : 'Direct Edit mode is ON. Prefer clean direct replacements; do not preserve old wording.';

  const settingsBlock = buildUserSettingsPromptBlock(promptSettings);

  const basePrompt = [
    `You are an expert ${targetDocumentLabel} editor.`,
    `Goal: tailor a base ${targetDocumentLabel} to one target job description while preserving truthfulness and professional tone.`,
    modeInstruction,
    `Limit redline operations to at most ${redlineCap}.`,
    `Draw from all provided context (resume, base ${targetDocumentLabel}, and sample letters) to find specific professional stories or experiences that directly address the job requirements.`,
    '',
    'Return ONLY valid JSON with this shape:',
    '{',
    '  "recommendation": "one concise explanation of the main optimization",',
    '  "inferredCompany": "best-effort company inferred from the job description if missing",',
    '  "inferredRole": "best-effort role inferred from the job description if missing",',
    '  "operations": [',
    '    { "type": "redline", "targetRef": "P4", "target": "exact paragraph text", "modified": "replacement text" },',
    '    { "type": "comment", "targetRef": "P4", "target": "exact paragraph text", "textToComment": "exact substring", "commentContent": "optional rationale" },',
    '    { "type": "highlight", "targetRef": "P4", "target": "exact paragraph text", "textToHighlight": "exact substring", "color": "green" }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- Use only provided paragraph references (P#).',
    '- Keep edits factual; do not invent credentials, but do adapt existing stories and experiences from the provided context to highlight relevance.',
    '- Keep total operations practical and targeted.',
    '- If company/role are missing in input, infer them and return values in inferredCompany/inferredRole.',
    ...(shouldUpdateDateLine && todayDateText
      ? [`- If the document has a visible date line, update it to today's date: ${todayDateText}.`]
      : []),
    '- Use exact target text from the paragraph map.'
  ].join('\n');

  return settingsBlock ? `${basePrompt}\n\n${settingsBlock}` : basePrompt;
}

function buildUserPrompt({
  sourceDocumentText,
  sourceDocumentLabel,
  paragraphs,
  secondaryContextLabel,
  secondaryContextText,
  sampleLettersText,
  job,
  todayDateText = ''
}) {
  const paragraphMap = (Array.isArray(paragraphs) ? paragraphs : [])
    .map(p => `[P${p.index}] ${p.text}`)
    .join('\n');

  return [
    'Target role:',
    `Company: ${String(job?.company || '').trim() || 'Unknown Company'}`,
    `Role: ${String(job?.role || '').trim() || 'Unknown Role'}`,
    ...(todayDateText ? [`Today's date: ${todayDateText}`] : []),
    '',
    'Goal: Tailor the document using evidence-based stories and experiences found in the source documents below.',
    '',
    'Job description:',
    '---',
    String(job?.description || '').slice(0, MAX_JOB_DESCRIPTION_CHARS),
    '---',
    '',
    sourceDocumentLabel,
    '---',
    String(sourceDocumentText || '').slice(0, MAX_BASE_LETTER_CHARS),
    '---',
    '',
    secondaryContextLabel,
    '---',
    String(secondaryContextText || '').slice(0, MAX_CONTEXT_CHARS),
    '---',
    '',
    'Sample letters context (optional):',
    '---',
    String(sampleLettersText || '').slice(0, MAX_CONTEXT_CHARS),
    '---',
    '',
    'Paragraph map for operation targeting:',
    paragraphMap,
    '',
    'Return only JSON.'
  ].join('\n');
}

async function callGeminiGenerateContent({
  apiKey,
  model,
  stage = 'unknown',
  systemPrompt,
  userPrompt,
  temperature = 0.35,
  maxOutputTokens = 24576,
  fetchFn = fetch
}) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature, maxOutputTokens }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw attachDebugInfo(
      new Error(`Gemini API ${response.status}: ${text.slice(0, 500)}`),
      {
        stage,
        model: String(model || '').trim() || 'unknown',
        httpStatus: response.status,
        responseLength: String(text || '').length,
        responsePreview: buildModelResponsePreview(text),
        ...buildResponseShapeDebugInfo(text)
      }
    );
  }

  const payload = await response.json();
  const parts = Array.isArray(payload?.candidates?.[0]?.content?.parts)
    ? payload.candidates[0].content.parts
    : [];
  const text = parts
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();

  const debugInfo = buildGeminiDebugInfo(payload, text, { stage, model });
  if (!text) {
    throw attachDebugInfo(new Error('Gemini returned empty response'), debugInfo);
  }

  return {
    text,
    debugInfo
  };
}

async function generateTailoredDocument({
  apiKey,
  model,
  promptSettings,
  sourceDocumentText,
  sourceDocumentLabel,
  targetDocumentLabel,
  paragraphs,
  secondaryContextLabel,
  secondaryContextText,
  sampleLettersText,
  job,
  mode,
  todayDateText = '',
  shouldUpdateDateLine = false,
  redlineCap = REDLINE_CAP,
  fetchFn = fetch
}) {
  const resolvedModel = normalizeGeminiModel(model);
  const raw = await callGeminiGenerateContent({
    stage: `${targetDocumentLabel}-tailoring`,
    apiKey,
    model: resolvedModel,
    systemPrompt: buildSystemPrompt({
      mode,
      redlineCap,
      promptSettings,
      targetDocumentLabel,
      todayDateText,
      shouldUpdateDateLine
    }),
    userPrompt: buildUserPrompt({
      sourceDocumentText,
      sourceDocumentLabel,
      paragraphs,
      secondaryContextLabel,
      secondaryContextText,
      sampleLettersText,
      job,
      todayDateText
    }),
    fetchFn
  });

  return {
    ...parseTailoringPayload(raw.text, {
      stage: `${targetDocumentLabel}-tailoring`,
      model: resolvedModel,
      apiDebugInfo: raw.debugInfo
    }),
    rawResponse: raw.text
  };
}

export async function generateTailoredCoverLetter({
  apiKey,
  model,
  promptSettings,
  baseLetterText,
  paragraphs,
  resumeText,
  sampleLettersText,
  job,
  mode,
  redlineCap = REDLINE_CAP,
  fetchFn = fetch
}) {
  const todayDateText = buildTodayDateText(new Date());
  return generateTailoredDocument({
    apiKey,
    model,
    promptSettings,
    sourceDocumentText: baseLetterText,
    sourceDocumentLabel: 'Base cover letter:',
    targetDocumentLabel: 'cover-letter',
    paragraphs,
    secondaryContextLabel: 'Resume context (optional):',
    secondaryContextText: resumeText,
    sampleLettersText,
    job,
    mode,
    todayDateText,
    shouldUpdateDateLine: true,
    redlineCap,
    fetchFn
  });
}

export async function generateTailoredResume({
  apiKey,
  model,
  promptSettings,
  resumeText,
  paragraphs,
  baseLetterText,
  sampleLettersText,
  job,
  mode,
  redlineCap = REDLINE_CAP,
  fetchFn = fetch
}) {
  return generateTailoredDocument({
    apiKey,
    model,
    promptSettings,
    sourceDocumentText: resumeText,
    sourceDocumentLabel: 'Base resume:',
    targetDocumentLabel: 'resume',
    paragraphs,
    secondaryContextLabel: 'Cover letter context (optional):',
    secondaryContextText: baseLetterText,
    sampleLettersText,
    job,
    mode,
    redlineCap,
    fetchFn
  });
}
