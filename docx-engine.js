import { ALLOWED_HIGHLIGHT_COLORS } from './constants.js';

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DEFAULT_HIGHLIGHT = 'yellow';

let cachedDepsPromise = null;
export const DOCX_REDLINE_VERSION = '0.8.0';

function getLocalName(node) {
  return String(node?.localName || node?.nodeName || '').replace(/^.*:/, '');
}

export function parseParagraphReference(rawValue) {
  if (Number.isInteger(rawValue) && rawValue > 0) return rawValue;

  const value = String(rawValue ?? '').trim();
  if (!value) return null;

  const direct = value.match(/^P?(\d+)$/i);
  if (direct) return Number(direct[1]);

  const bracket = value.match(/^\[\s*P(\d+)\s*]$/i);
  if (bracket) return Number(bracket[1]);

  return null;
}

export function stripLeadingParagraphMarker(text) {
  return String(text ?? '').replace(/^\s*\[\s*P\d+\s*]\s*/i, '').replace(/^\s*P\d+\s*/i, '').trim();
}

function splitLeadingParagraphMarker(text) {
  const raw = String(text ?? '');
  const match = raw.match(/^\s*(?:\[\s*)?P(\d+)(?:\s*])?\s*(.*)$/i);
  if (!match) return { targetRef: null, text: raw.trim() };
  return {
    targetRef: Number(match[1]),
    text: String(match[2] || '').trim()
  };
}

export function normalizeAndFilterOperations(rawOperations) {
  const input = Array.isArray(rawOperations) ? rawOperations : [];

  return input
    .map(rawOp => {
      if (!rawOp || typeof rawOp !== 'object') return null;

      const type = String(rawOp.type || '').toLowerCase().trim();
      const splitTarget = splitLeadingParagraphMarker(rawOp.target);
      const explicitRef = parseParagraphReference(
        rawOp.targetRef ?? rawOp.paragraphRef ?? rawOp.paragraphIndex ?? rawOp.targetIndex
      );
      const explicitEndRef = parseParagraphReference(
        rawOp.targetEndRef ?? rawOp.endTargetRef ?? rawOp.endParagraphRef ?? rawOp.endParagraphIndex
      );

      const normalized = {
        ...rawOp,
        type,
        targetRef: explicitRef || splitTarget.targetRef || null,
        targetEndRef: explicitEndRef || null,
        target: splitTarget.text
      };

      if (normalized.modified != null) {
        normalized.modified = stripLeadingParagraphMarker(normalized.modified);
      }
      if (normalized.textToComment != null) {
        normalized.textToComment = stripLeadingParagraphMarker(normalized.textToComment);
      }
      if (normalized.textToHighlight != null) {
        normalized.textToHighlight = stripLeadingParagraphMarker(normalized.textToHighlight);
      }
      if (normalized.commentContent != null) {
        normalized.commentContent = String(normalized.commentContent).trim();
      }

      if (type === 'highlight') {
        const color = String(normalized.color || '').toLowerCase();
        normalized.color = ALLOWED_HIGHLIGHT_COLORS.includes(color) ? color : DEFAULT_HIGHLIGHT;
      }

      return normalized;
    })
    .filter(op => {
      if (!op?.type) return false;
      if (!op.target && !op.targetRef) return false;

      if (op.type === 'comment') {
        return Boolean(op.textToComment && op.commentContent);
      }
      if (op.type === 'highlight') {
        return Boolean(op.textToHighlight);
      }
      if (op.type === 'redline') {
        return Boolean(op.modified || (Array.isArray(op.replacements) && op.replacements.length > 0));
      }
      return false;
    });
}

// Word splits text into runs unpredictably and substitutes typographic characters
// (smart quotes, en/em dashes, non-breaking spaces). The model is asked to echo "exact"
// text, but its copy often differs from the document byte-for-byte, so the engine fails to
// locate it. These helpers reconcile model-provided targets back to the document's real text.
const TYPOGRAPHIC_REPLACEMENTS = new Map([
  ['\u2018', "'"], ['\u2019', "'"], ['\u201b', "'"], ['\u2032', "'"],
  ['\u201c', '"'], ['\u201d', '"'], ['\u201f', '"'], ['\u2033', '"'],
  ['\u2013', '-'], ['\u2014', '-'], ['\u2212', '-'],
  ['\u00a0', ' '], ['\u2007', ' '], ['\u202f', ' ']
]);

// Build a whitespace-collapsed, typography-normalized string plus a map from each
// normalized character back to its original index, so a match can be sliced out verbatim.
function buildNormalizedIndex(text) {
  const src = String(text ?? '');
  let normalized = '';
  const indexMap = [];
  let prevWasSpace = false;

  for (let i = 0; i < src.length; i += 1) {
    let ch = TYPOGRAPHIC_REPLACEMENTS.get(src[i]) ?? src[i];
    if (/\s/.test(ch)) {
      if (prevWasSpace) continue;
      ch = ' ';
      prevWasSpace = true;
    } else {
      prevWasSpace = false;
    }
    normalized += ch;
    indexMap.push(i);
  }

  return { normalized, indexMap };
}

export function normalizeForMatch(text) {
  return buildNormalizedIndex(text).normalized.trim();
}

function tokenizeForDice(text) {
  return normalizeForMatch(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

export function diceSimilarity(a, b) {
  const leftTokens = tokenizeForDice(a);
  const rightTokens = tokenizeForDice(b);
  if (leftTokens.length === 0 && rightTokens.length === 0) return 1;
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const toBigrams = tokens => {
    if (tokens.length === 1) return [tokens[0]];
    const bigrams = [];
    for (let i = 0; i < tokens.length - 1; i += 1) {
      bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
    return bigrams;
  };

  const left = toBigrams(leftTokens);
  const right = toBigrams(rightTokens);
  const rightCounts = new Map();
  for (const item of right) {
    rightCounts.set(item, (rightCounts.get(item) || 0) + 1);
  }

  let overlap = 0;
  for (const item of left) {
    const count = rightCounts.get(item) || 0;
    if (count > 0) {
      overlap += 1;
      rightCounts.set(item, count - 1);
    }
  }

  return (2 * overlap) / (left.length + right.length);
}

// Return the exact original substring of `haystack` that matches `needle` modulo
// whitespace/typography, or null when there is no confident match.
export function findOriginalSubstring(haystack, needle) {
  const wanted = normalizeForMatch(needle);
  if (!wanted) return null;

  const { normalized, indexMap } = buildNormalizedIndex(haystack);
  const pos = normalized.indexOf(wanted);
  if (pos < 0) return null;

  const startOrig = indexMap[pos];
  const endOrig = indexMap[pos + wanted.length - 1];
  return String(haystack ?? '').slice(startOrig, endOrig + 1);
}

// Snap each operation's anchor/substring fields to the document's exact characters using
// the paragraph map (keyed by P# index). Only repairs when the same paragraph/substring is
// clearly identified — never relocates an operation to a different paragraph.
export function reconcileOperationsWithParagraphs(operations, paragraphs, { onInfo = () => { } } = {}) {
  const byIndex = new Map();
  const paragraphList = [];
  for (const paragraph of Array.isArray(paragraphs) ? paragraphs : []) {
    if (paragraph && Number.isInteger(paragraph.index)) {
      const text = String(paragraph.text ?? '');
      byIndex.set(paragraph.index, text);
      paragraphList.push({ index: paragraph.index, text });
    }
  }

  return (Array.isArray(operations) ? operations : []).map(op => {
    if (!op || typeof op !== 'object') return op;

    const ref = Number.isInteger(op.targetRef) ? op.targetRef : null;
    const next = { ...op };
    const targetRaw = typeof next.target === 'string' ? next.target.trim() : '';
    const normalizedTarget = normalizeForMatch(targetRaw);
    let paragraphText = ref != null ? byIndex.get(ref) : undefined;
    let shouldSnapTarget = false;

    // Anchor on the document's exact paragraph text when the model's target refers to the
    // same paragraph (one contains the other once normalized). When that fails, try one
    // conservative fuzzy re-anchor across all paragraphs.
    if (paragraphText) {
      const normalizedParagraph = normalizeForMatch(paragraphText);
      shouldSnapTarget = !targetRaw
        || (normalizedTarget && normalizedParagraph
          && (normalizedParagraph.includes(normalizedTarget) || normalizedTarget.includes(normalizedParagraph)));
    }

    if (!shouldSnapTarget && normalizedTarget) {
      const scored = paragraphList
        .map(paragraph => ({
          ...paragraph,
          score: diceSimilarity(normalizedTarget, paragraph.text)
        }))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      const runnerUp = scored[1];
      if (best && best.score >= 0.82 && best.score - (runnerUp?.score || 0) >= 0.06) {
        paragraphText = best.text;
        next.targetRef = best.index;
        shouldSnapTarget = true;
        onInfo(`Re-anchored ${String(next.type || 'operation')} target to P${best.index} (similarity ${best.score.toFixed(2)}).`);
      }
    }

    if (!paragraphText) return op;
    if (shouldSnapTarget) {
      next.target = paragraphText;
    }

    for (const field of ['textToComment', 'textToHighlight']) {
      if (typeof next[field] === 'string' && next[field].trim()) {
        const exact = findOriginalSubstring(paragraphText, next[field]);
        if (exact) next[field] = exact;
      }
    }

    return next;
  });
}

export function chunkOperations(items, chunkSize) {
  const input = Array.isArray(items) ? items : [];
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : input.length || 1;
  const out = [];
  for (let start = 0; start < input.length; start += size) {
    out.push(input.slice(start, start + size));
  }
  return out;
}

async function tryImportFirst(urls) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await import(url);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error('No import URL candidates provided');
}

export async function loadEngineDependencies(log = () => { }) {
  if (cachedDepsPromise) return cachedDepsPromise;

  cachedDepsPromise = (async () => {
    const isNode = typeof process !== 'undefined' && process?.versions?.node;
    const candidates = [];

    // Local / Node file paths
    if (isNode) {
      candidates.push(
        './scratch/docx-redline.bundle.js',
        '../Docx Redline JS/dist/docx-redline.bundle.js',
        '../Docx Redline JS/index.js',
        '@ansonlai/docx-redline-js/bundle',
        '@ansonlai/docx-redline-js'
      );
    }

    // Canonical CDN URLs (Zero-dependency standalone v0.8.0 bundle)
    candidates.push(
      `https://cdn.jsdelivr.net/npm/@ansonlai/docx-redline-js@${DOCX_REDLINE_VERSION}/dist/docx-redline.bundle.js`,
      `https://esm.sh/@ansonlai/docx-redline-js@${DOCX_REDLINE_VERSION}/dist/docx-redline.bundle.js`
    );

    const module = await tryImportFirst(candidates);

    if (typeof module.configureLogger === 'function') {
      module.configureLogger({
        log: (...parts) => log(parts.join(' ')),
        warn: (...parts) => log(`[WARN] ${parts.join(' ')}`),
        error: (...parts) => log(`[ERROR] ${parts.join(' ')}`)
      });
    }

    return module;
  })();

  return cachedDepsPromise;
}

/**
 * Returns whether an XML node contributes to the selected revision view.
 * Excludes deleted/moveFrom elements in 'accepted' view, and inserted/moveTo elements in 'rejected' view.
 */
function isNodeVisibleInRevisionView(node, boundary = null, revisionView = 'accepted') {
  const view = revisionView === 'current' ? 'accepted' : revisionView;
  let cursor = node;
  while (cursor && cursor !== boundary) {
    const name = getLocalName(cursor);
    if (view === 'accepted' && (name === 'del' || name === 'moveFrom')) return false;
    if (view === 'rejected' && (name === 'ins' || name === 'moveTo')) return false;
    cursor = cursor.parentNode;
  }
  return true;
}

/**
 * Extracts canonical paragraph text matching OOXML engine semantics:
 * evaluates accepted/current document view, excluding deleted and w:moveFrom runs
 * while preserving structural breaks (tabs, breaks, non-breaking hyphens, soft hyphens).
 */
export function extractCanonicalParagraphText(paragraph, options = {}) {
  if (!paragraph) return '';
  const revisionView = options.revisionView === 'current' ? 'accepted' : (options.revisionView || 'accepted');
  let text = '';

  function walk(node) {
    for (const child of Array.from(node?.childNodes || [])) {
      if (child?.nodeType !== 1) continue;
      if (child.namespaceURI && child.namespaceURI !== NS_W) continue;
      if (!isNodeVisibleInRevisionView(child, paragraph, revisionView)) continue;

      const name = getLocalName(child);
      if (name === 'pPr' || name === 'rPr') continue;

      if (name === 't') {
        text += child.textContent || '';
      } else if (name === 'delText') {
        if (revisionView === 'rejected') {
          text += child.textContent || '';
        }
      } else if (name === 'tab') {
        text += '\t';
      } else if (name === 'br' || name === 'cr') {
        text += '\n';
      } else if (name === 'noBreakHyphen') {
        text += '\u2011';
      } else if (name === 'softHyphen') {
        text += '\u00ad';
      } else {
        walk(child);
      }
    }
  }

  walk(paragraph);
  return text;
}

function getParagraphNodes(body) {
  if (!body) return [];
  const namespaced = body.getElementsByTagNameNS(NS_W, 'p');
  if (namespaced.length > 0) return Array.from(namespaced);
  return Array.from(body.getElementsByTagName('*')).filter(node => getLocalName(node) === 'p');
}

export function extractParagraphsFromDocumentXml(documentXml) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(String(documentXml || ''), 'application/xml');
  const body = xmlDoc.getElementsByTagNameNS(NS_W, 'body')[0]
    || Array.from(xmlDoc.getElementsByTagName('*')).find(node => getLocalName(node) === 'body');

  if (!body) throw new Error('No w:body found in document.xml');

  const paragraphs = [];
  for (const paragraph of getParagraphNodes(body)) {
    const text = extractCanonicalParagraphText(paragraph).trim();
    if (!text) continue;
    paragraphs.push({
      index: paragraphs.length + 1,
      text
    });
  }
  return paragraphs;
}

function extractParagraphsFromDoc(doc) {
  if (!doc || typeof doc.inspect !== 'function') return [];
  const inspection = doc.inspect({ revisionView: 'accepted' });
  return (inspection.paragraphs || [])
    .map(p => ({
      index: p.index,
      ref: p.ref || `P${p.index}`,
      paragraphId: p.paragraphId || null,
      fingerprint: p.fingerprint || null,
      text: String(p.exactText ?? p.text ?? '').trim()
    }))
    .filter(p => p.text);
}

export async function extractDocumentParagraphs(docOrZip) {
  if (docOrZip && typeof docOrZip.inspect === 'function') {
    return extractParagraphsFromDoc(docOrZip);
  }
  if (docOrZip && typeof docOrZip.file === 'function') {
    const xml = await docOrZip.file('word/document.xml')?.async('string');
    if (!xml) throw new Error('word/document.xml not found');
    return extractParagraphsFromDocumentXml(xml);
  }
  throw new Error('Unsupported document format for paragraph extraction');
}

export async function loadDocxFromBlob(blob) {
  if (!blob) throw new Error('Missing document blob');
  const deps = await loadEngineDependencies();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return deps.openDocx(bytes);
}

// Backward-compatibility alias
export const loadDocxZipFromBlob = loadDocxFromBlob;

export async function ingestDocxFile(file) {
  const isDocx = /\.docx$/i.test(String(file?.name || ''));
  if (!isDocx) throw new Error('Only .docx files are supported');

  const deps = await loadEngineDependencies();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = deps.openDocx(bytes);
  const paragraphs = extractParagraphsFromDoc(doc);

  return {
    doc,
    zip: doc, // Backward-compatibility alias
    paragraphs,
    fullText: paragraphs.map(p => p.text).join('\n'),
    fileName: String(file.name || 'document.docx')
  };
}

export async function generateBlobFromDoc(doc) {
  if (!doc) throw new Error('Missing document instance');
  const u8 = typeof doc.toUint8Array === 'function'
    ? doc.toUint8Array()
    : (typeof doc.generateAsync === 'function' ? await doc.generateAsync({ type: 'uint8array' }) : null);

  if (!u8) throw new Error('Unable to serialize document to bytes');
  return new Blob([u8], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
}

// Backward-compatibility alias
export const generateBlobFromZip = generateBlobFromDoc;

// Describe why a single operation did not land, distinguishing engine errors from the
// common "no change" case where the model's target text was not found in the document.
export function describeOperationFailure(result) {
  const ref = Number.isInteger(result?.targetRef) && result.targetRef > 0
    ? `P${result.targetRef}`
    : 'unknown paragraph';
  const type = String(result?.type || 'operation').trim() || 'operation';
  let reason = 'target text was not found in the document';
  if (result?.error) {
    if (typeof result.error === 'object') {
      reason = result.error.message || result.error.code || JSON.stringify(result.error);
    } else {
      reason = String(result.error);
    }
  }
  return `${type} on ${ref}: ${reason}`;
}

export function summarizeOperationFailures(results) {
  return (Array.isArray(results) ? results : [])
    .filter(result => result && !result.success)
    .map(describeOperationFailure);
}

export async function applyOperationsInBatches({
  doc,
  zip,
  operations,
  author,
  batchSize = 3,
  generateRedlines = true,
  existingRevisions = 'slice-cross-author',
  onProgress = () => { },
  onLog = () => { }
}) {
  const targetDoc = doc || zip;
  if (!targetDoc) throw new Error('Missing document instance');

  const batches = chunkOperations(operations, batchSize);
  const allResults = [];
  let lastResult = null;

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    try {
      lastResult = await targetDoc.applyOperations(batch, {
        author,
        generateRedlines: Boolean(generateRedlines),
        existingRevisions,
        validate: true
      });

      const batchResults = (lastResult.results || []).map((r, idx) => {
        const op = batch[idx] || {};
        const stepError = r.error
          ? (typeof r.error === 'object'
            ? (r.error.message || r.error.code || JSON.stringify(r.error))
            : String(r.error))
          : (r.status === 'error' || r.status === 'refused' ? 'Operation returned error status' : null);

        const isApplied = r.status === 'applied'
          || r.receipt?.committed === true
          || r.receipt?.finalDisposition === 'applied';

        return {
          ...op,
          ...r,
          success: Boolean(r.success ?? (isApplied && !stepError)),
          receipt: r.receipt || null,
          error: stepError
        };
      });
      allResults.push(...batchResults);
    } catch (batchError) {
      onLog(`[ERROR] Batch ${i + 1} application failed: ${batchError?.message || String(batchError)}`);
      for (const op of batch) {
        allResults.push({ ...op, success: false, error: batchError?.message || String(batchError) });
      }
    }

    onProgress({
      batchIndex: i + 1,
      totalBatches: batches.length,
      completed: allResults.length,
      totalOperations: operations.length
    });
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const generatedIssues = lastResult?.validation?.generatedIssues || lastResult?.issues || [];
  const validationOk = !lastResult?.error && generatedIssues.length === 0;
  const validationError = !validationOk
    ? (lastResult?.error?.message || (generatedIssues[0]?.message || 'Package validation error'))
    : null;

  return {
    results: allResults,
    validation: {
      ok: validationOk,
      error: validationError,
      issues: generatedIssues
    },
    failures: summarizeOperationFailures(allResults)
  };
}

export async function acceptAllTrackedChangesInDoc({
  doc,
  zip,
  allAuthors = true,
  author = '',
  onLog = () => { }
}) {
  const targetDoc = doc || zip;
  if (!targetDoc) throw new Error('Missing document instance');

  if (typeof targetDoc.resolveRevisions !== 'function') {
    throw new Error('Document does not support resolveRevisions');
  }

  const result = await targetDoc.resolveRevisions('accept', {
    allAuthors,
    author: String(author || '').trim(),
    validate: true
  });

  const warnings = Array.isArray(result?.warnings) ? result.warnings.map(String) : [];
  if (result?.error) {
    const errorMsg = result.error.message || String(result.error);
    warnings.push(errorMsg);
    onLog(`[ERROR] ${errorMsg}`);
  }

  return {
    hasChanges: Boolean(result?.hasChanges),
    acceptedCount: Number(result?.acceptedCount || (result?.results?.length ?? 0)),
    warnings
  };
}

// Backward-compatibility alias
export const acceptAllTrackedChangesInZip = acceptAllTrackedChangesInDoc;

const PREVIEW_RENDER_OPTIONS = {
  inWrapper: true,
  renderChanges: true,
  renderComments: false,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  breakPages: true,
  useBase64URL: true
};

function resolvePreviewRenderer() {
  const globalRenderer = globalThis?.docx?.renderAsync;
  if (typeof globalRenderer === 'function') return globalRenderer.bind(globalThis.docx);
  return null;
}

async function resolveRenderAsync() {
  let renderAsync = resolvePreviewRenderer();
  if (!renderAsync) {
    const previewModule = await tryImportFirst([
      'https://cdn.jsdelivr.net/npm/docx-preview@0.3.6/+esm',
      'https://esm.sh/docx-preview@0.3.6'
    ]);
    renderAsync = previewModule?.renderAsync || previewModule?.default?.renderAsync || null;
  }
  if (typeof renderAsync !== 'function') {
    throw new Error('docx-preview renderer unavailable');
  }
  return renderAsync;
}

async function renderPreviewBuffer(buffer, previewHost, statusCallback) {
  const renderAsync = await resolveRenderAsync();
  statusCallback('Rendering preview...');
  previewHost.replaceChildren();
  await renderAsync(buffer, previewHost, null, PREVIEW_RENDER_OPTIONS);
  statusCallback('Preview updated');
}

// Fast path: render straight from a stored .docx blob without an unzip/re-zip round-trip.
export async function renderPreviewFromBlob(blob, previewHost, statusCallback = () => { }) {
  if (!previewHost || !blob) return;
  await renderPreviewBuffer(await blob.arrayBuffer(), previewHost, statusCallback);
}

export async function renderPreviewFromZip(docOrZip, previewHost, statusCallback = () => { }) {
  if (!previewHost || !docOrZip) return;
  const blob = await generateBlobFromDoc(docOrZip);
  await renderPreviewBuffer(await blob.arrayBuffer(), previewHost, statusCallback);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadZipAsDocx(docOrZip, outputFileName) {
  const blob = await generateBlobFromDoc(docOrZip);
  downloadBlob(blob, outputFileName);
}

async function getJsZipCtor() {
  if (globalThis.JSZip) return globalThis.JSZip;
  const module = await import('https://esm.sh/jszip@3.10.1');
  const ctor = module?.default || module?.JSZip || module;
  if (!ctor) throw new Error('Unable to load JSZip');
  globalThis.JSZip = ctor;
  return ctor;
}

export async function createArchiveBlob(files) {
  const JSZipCtor = await getJsZipCtor();
  const archive = new JSZipCtor();

  for (const file of Array.isArray(files) ? files : []) {
    if (!file?.name || !file?.blob) continue;
    archive.file(String(file.name), file.blob);
  }

  return archive.generateAsync({ type: 'blob' });
}
