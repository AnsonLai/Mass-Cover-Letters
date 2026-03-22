import { ALLOWED_HIGHLIGHT_COLORS } from './constants.js';

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DEFAULT_HIGHLIGHT = 'yellow';

let cachedDepsPromise = null;
const DOCX_REDLINE_VERSION = '0.1.4';

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
        return Boolean(op.modified);
      }
      return false;
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

async function getJsZipCtor() {
  if (globalThis.JSZip) return globalThis.JSZip;
  const module = await import('https://esm.sh/jszip@3.10.1');
  const ctor = module?.default || module?.JSZip || module;
  if (!ctor) throw new Error('Unable to load JSZip');
  globalThis.JSZip = ctor;
  return ctor;
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

async function loadEngineDependencies(log = () => {}) {
  if (cachedDepsPromise) return cachedDepsPromise;

  cachedDepsPromise = (async () => {
    const baseModule = await tryImportFirst([
      `https://cdn.jsdelivr.net/npm/@ansonlai/docx-redline-js@${DOCX_REDLINE_VERSION}/+esm`,
      './legal-skills-drafter/node_modules/@ansonlai/docx-redline-js/index.js',
      'https://esm.sh/@ansonlai/docx-redline-js'
    ]);

    const runnerModule = await tryImportFirst([
      `https://cdn.jsdelivr.net/npm/@ansonlai/docx-redline-js@${DOCX_REDLINE_VERSION}/services/standalone-operation-runner.js/+esm`,
      './legal-skills-drafter/node_modules/@ansonlai/docx-redline-js/services/standalone-operation-runner.js',
      'https://esm.sh/@ansonlai/docx-redline-js/services/standalone-operation-runner.js'
    ]);

    if (typeof baseModule.configureLogger === 'function') {
      baseModule.configureLogger({
        log: (...parts) => log(parts.join(' ')),
        warn: (...parts) => log(`[WARN] ${parts.join(' ')}`),
        error: (...parts) => log(`[ERROR] ${parts.join(' ')}`)
      });
    }

    if (typeof runnerModule.applyOperationToDocumentXml !== 'function') {
      throw new Error('Loaded docx runner module does not export applyOperationToDocumentXml');
    }

    return {
      ...baseModule,
      applyOperationToDocumentXml: runnerModule.applyOperationToDocumentXml
    };
  })();

  return cachedDepsPromise;
}

function getParagraphNodes(body) {
  if (!body) return [];
  const namespaced = body.getElementsByTagNameNS(NS_W, 'p');
  if (namespaced.length > 0) return Array.from(namespaced);
  return Array.from(body.getElementsByTagName('*')).filter(node => getLocalName(node) === 'p');
}

function extractTextFromParagraph(paragraph) {
  if (!paragraph) return '';
  const textNodes = paragraph.getElementsByTagNameNS(NS_W, 't');
  const nodes = textNodes.length > 0
    ? Array.from(textNodes)
    : Array.from(paragraph.getElementsByTagName('*')).filter(node => getLocalName(node) === 't');
  return nodes.map(node => node.textContent || '').join('');
}

export function extractParagraphsFromDocumentXml(documentXml) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(String(documentXml || ''), 'application/xml');
  const body = xmlDoc.getElementsByTagNameNS(NS_W, 'body')[0]
    || Array.from(xmlDoc.getElementsByTagName('*')).find(node => getLocalName(node) === 'body');

  if (!body) throw new Error('No w:body found in document.xml');

  const paragraphs = [];
  for (const paragraph of getParagraphNodes(body)) {
    const text = extractTextFromParagraph(paragraph).trim();
    if (!text) continue;
    paragraphs.push({
      index: paragraphs.length + 1,
      text
    });
  }
  return paragraphs;
}

export async function extractDocumentParagraphs(zip) {
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('word/document.xml not found');
  return extractParagraphsFromDocumentXml(xml);
}

export async function ingestDocxFile(file) {
  const isDocx = /\.docx$/i.test(String(file?.name || ''));
  if (!isDocx) throw new Error('Only .docx files are supported');

  const JSZipCtor = await getJsZipCtor();
  const zip = await JSZipCtor.loadAsync(await file.arrayBuffer());
  const paragraphs = await extractDocumentParagraphs(zip);
  return {
    zip,
    paragraphs,
    fullText: paragraphs.map(p => p.text).join('\n'),
    fileName: String(file.name || 'document.docx')
  };
}

export async function loadDocxZipFromBlob(blob) {
  const JSZipCtor = await getJsZipCtor();
  return JSZipCtor.loadAsync(await blob.arrayBuffer());
}

function normalizeDocumentXml(xml, deps, log) {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const xmlDoc = parser.parseFromString(xml, 'application/xml');

  if (typeof deps.normalizeBodySectionOrderStandalone === 'function') {
    deps.normalizeBodySectionOrderStandalone(xmlDoc);
  }
  if (typeof deps.sanitizeNestedParagraphsInTables === 'function') {
    deps.sanitizeNestedParagraphsInTables(xmlDoc, {
      onInfo: message => log(String(message))
    });
  }

  return serializer.serializeToString(xmlDoc);
}

async function applyOperationsBatch(zip, operations, { author, log, generateRedlines = true }) {
  const deps = await loadEngineDependencies(log);
  let documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('word/document.xml not found');

  const existingNumberingXml = await zip.file('word/numbering.xml')?.async('string');
  const numberingIdState = typeof deps.createDynamicNumberingIdState === 'function'
    ? deps.createDynamicNumberingIdState(existingNumberingXml || '', { minId: 1, maxPreferred: 32767 })
    : null;

  const runtimeContext = {
    numberingIdState,
    listFallbackSharedNumIdByKey: new Map(),
    listFallbackSequenceState: { explicitByNumberingKey: new Map() },
    tableStructuralRedlineKeys: new Set()
  };

  const capturedNumberingXml = [];
  const capturedCommentsXml = [];
  const results = [];

  for (const op of operations) {
    try {
      const step = await deps.applyOperationToDocumentXml(documentXml, op, author, runtimeContext, {
        generateRedlines: Boolean(generateRedlines),
        onInfo: message => log(String(message)),
        onWarn: message => log(`[WARN] ${String(message)}`)
      });

      documentXml = step.documentXml;
      if (step.numberingXml) capturedNumberingXml.push(step.numberingXml);
      if (step.commentsXml) capturedCommentsXml.push(step.commentsXml);
      if (Array.isArray(step.warnings)) {
        for (const warning of step.warnings) {
          log(`[WARN] ${String(warning)}`);
        }
      }

      results.push({ ...op, success: Boolean(step.hasChanges), error: null });
    } catch (error) {
      results.push({ ...op, success: false, error: error?.message || String(error) });
    }
  }

  documentXml = normalizeDocumentXml(documentXml, deps, log);
  zip.file('word/document.xml', documentXml);

  if (typeof deps.ensureNumberingArtifactsInZip === 'function' && capturedNumberingXml.length > 0) {
    await deps.ensureNumberingArtifactsInZip(zip, capturedNumberingXml, {
      mergeNumberingXml: (existingXml, incomingXml) => {
        if (typeof deps.mergeNumberingXmlBySchemaOrder === 'function') {
          return deps.mergeNumberingXmlBySchemaOrder(existingXml, incomingXml);
        }
        return existingXml || incomingXml;
      },
      onInfo: message => log(String(message))
    });
  }

  if (typeof deps.ensureCommentsArtifactsInZip === 'function' && capturedCommentsXml.length > 0) {
    for (const commentsXml of capturedCommentsXml) {
      await deps.ensureCommentsArtifactsInZip(zip, commentsXml, {
        onInfo: message => log(String(message))
      });
    }
  }

  if (typeof deps.validateDocxPackage === 'function') {
    try {
      await deps.validateDocxPackage(zip);
    } catch (error) {
      log(`[WARN] Package validation warning: ${error?.message || String(error)}`);
    }
  }

  return results;
}

export async function applyOperationsInBatches({
  zip,
  operations,
  author,
  batchSize = 3,
  generateRedlines = true,
  onProgress = () => {},
  onLog = () => {}
}) {
  const batches = chunkOperations(operations, batchSize);
  const allResults = [];

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const batchResults = await applyOperationsBatch(zip, batch, {
      author,
      log: onLog,
      generateRedlines
    });
    allResults.push(...batchResults);
    onProgress({
      batchIndex: i + 1,
      totalBatches: batches.length,
      completed: allResults.length,
      totalOperations: operations.length
    });
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  return allResults;
}

export async function acceptAllTrackedChangesInZip({
  zip,
  allAuthors = true,
  author = '',
  onLog = () => {}
}) {
  if (!zip) throw new Error('Missing document package');

  const deps = await loadEngineDependencies(onLog);
  if (typeof deps.acceptTrackedChangesInOoxml !== 'function') {
    throw new Error('Tracked-change acceptance helper unavailable');
  }

  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('word/document.xml not found');

  const options = allAuthors
    ? { allAuthors: true }
    : { author: String(author || '').trim() };
  const result = deps.acceptTrackedChangesInOoxml(documentXml, options);
  const warnings = Array.isArray(result?.warnings) ? result.warnings.map(item => String(item)) : [];

  for (const warning of warnings) {
    onLog(`[WARN] ${warning}`);
  }

  if (result?.hasChanges) {
    const normalizedXml = normalizeDocumentXml(String(result.oxml || ''), deps, onLog);
    zip.file('word/document.xml', normalizedXml);

    if (typeof deps.validateDocxPackage === 'function') {
      try {
        await deps.validateDocxPackage(zip);
      } catch (error) {
        onLog(`[WARN] Package validation warning: ${error?.message || String(error)}`);
      }
    }
  }

  return {
    hasChanges: Boolean(result?.hasChanges),
    acceptedCount: Number(result?.acceptedCount || 0),
    warnings
  };
}

function resolvePreviewRenderer() {
  const globalRenderer = globalThis?.docx?.renderAsync;
  if (typeof globalRenderer === 'function') return globalRenderer.bind(globalThis.docx);
  return null;
}

export async function renderPreviewFromZip(zip, previewHost, statusCallback = () => {}) {
  if (!previewHost || !zip) return;

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

  statusCallback('Rendering preview...');
  const blob = await zip.generateAsync({ type: 'blob' });
  const buffer = await blob.arrayBuffer();
  previewHost.replaceChildren();
  await renderAsync(buffer, previewHost, null, {
    inWrapper: true,
    renderChanges: true,
    renderComments: false,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    breakPages: true,
    useBase64URL: true
  });

  statusCallback('Preview updated');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function generateBlobFromZip(zip) {
  return zip.generateAsync({ type: 'blob' });
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

export async function downloadZipAsDocx(zip, outputFileName) {
  const blob = await generateBlobFromZip(zip);
  downloadBlob(blob, outputFileName);
}
