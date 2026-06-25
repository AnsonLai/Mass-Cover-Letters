import {
  APP_VERSION,
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODEL_OPTIONS,
  JOB_STATUS_LABELS,
  OPERATION_BATCH_SIZE,
  REDLINE_CAP,
  STORAGE_KEYS
} from './constants.js';
import {
  generateTailoredCoverLetter,
  generateTailoredResume,
  normalizeGeminiModel,
  validateGeminiApiKey
} from './cover-letter-ai.js';
import {
  acceptAllTrackedChangesInZip,
  applyOperationsInBatches,
  createArchiveBlob,
  downloadBlob,
  generateBlobFromZip,
  ingestDocxFile,
  loadDocxZipFromBlob,
  normalizeAndFilterOperations,
  reconcileOperationsWithParagraphs,
  renderPreviewFromBlob
} from './docx-engine.js';
import {
  createDocumentStore
} from './document-store.js';
import {
  formatJobDisplayName,
  getUiRefs,
  renderJobList,
  renderSelectedJob,
  setActionEnabled,
  setDropZoneActive,
  setModeButtons,
  setPreviewTypeButtons,
  setPreviewStatus,
  setStatusBanner
} from './ui.js';

const AUTHOR_NAME = 'Application Station';
const RUN_ALL_CONCURRENCY = 2;
const BASE_SOURCE_KEY = 'base:source';
const RESUME_SOURCE_KEY = 'resume:source';
const SAMPLE_SOURCE_KEY_PREFIX = 'sample:source';
const SESSION_STATE_KEY = 'session:state';
const ONBOARDING_STEPS = ['api', 'docs', 'job', 'generate'];

const state = createAppState();

function createAppState() {
  return {
    editMode: 'track',
    theme: 'light',
    includeComments: false,
    promptSettings: {
      model: DEFAULT_GEMINI_MODEL,
      voice: '',
      extraGuidance: ''
    },
    baseDocument: {
      fileName: '',
      paragraphs: []
    },
    resumeDocument: {
      fileName: '',
      paragraphs: []
    },
    sampleDocuments: [],
    jobs: [],
    selectedJobId: null,
    previewType: 'coverLetter',
    isValidatingApiKey: false,
    onboarding: {
      dismissed: false,
      forcedOpen: false
    },
    isRunning: false,
    store: null
  };
}

function createJobId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function inferJobMetadataFromDescription(description) {
  const text = String(description || '');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  const companyMatch = text.match(/(?:^|\n)\s*company\s*:\s*(.+)$/im);
  const roleMatch = text.match(/(?:^|\n)\s*(?:role|title|position|job title)\s*:\s*(.+)$/im);
  if (companyMatch || roleMatch) {
    return {
      company: String(companyMatch?.[1] || '').trim(),
      role: String(roleMatch?.[1] || '').trim()
    };
  }

  const firstLine = lines[0] || '';
  if (firstLine.includes('|')) {
    const [company, role] = firstLine.split('|').map(part => String(part || '').trim());
    return { company: company || '', role: role || '' };
  }

  const dashParts = firstLine.split(' - ').map(part => part.trim()).filter(Boolean);
  if (dashParts.length >= 2) {
    return { company: dashParts[0], role: dashParts[1] };
  }

  const atMatch = firstLine.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) {
    return { role: String(atMatch[1] || '').trim(), company: String(atMatch[2] || '').trim() };
  }

  return { company: '', role: '' };
}

export function createCoverLetterJob({ company, role, description }) {
  const id = createJobId();
  const normalizedDescription = String(description || '').trim();
  const inferred = inferJobMetadataFromDescription(normalizedDescription);
  const normalizedCompany = String(company || '').trim() || inferred.company;
  const normalizedRole = String(role || '').trim() || inferred.role;

  return {
    id,
    company: normalizedCompany,
    role: normalizedRole,
    description: normalizedDescription,
    status: 'queued',
    recommendation: '',
    coverLetterOperationCount: 0,
    resumeOperationCount: 0,
    operationCount: 0,
    failedOperationCount: 0,
    failedOperations: [],
    validationError: '',
    runtime: {
      error: null
    },
    storage: {
      resultKey: `${id}:result`,
      resumeResultKey: `${id}:resume-result`,
      detailsKey: `${id}:details`
    }
  };
}

export function filterDocxFiles(fileList) {
  return Array.from(fileList || []).filter(file => /\.docx$/i.test(String(file?.name || '')));
}

export function getNextRunnableJob(jobs) {
  return (Array.isArray(jobs) ? jobs : [])
    .find(job => ['queued', 'retry'].includes(String(job?.status || '').toLowerCase())) || null;
}

function sanitizeFileNamePart(value) {
  return String(value || '')
    .replace(/[_]+/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

const UPPERCASE_FILE_NAME_TOKENS = new Set([
  'AI',
  'API',
  'CEO',
  'CFO',
  'COO',
  'CTO',
  'HR',
  'LLC',
  'LTD',
  'ML',
  'NLP',
  'QA',
  'R&D',
  'UI',
  'UK',
  'USA',
  'UX',
  'VP'
]);

function toTitleCase(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const titleCased = raw
    .toLowerCase()
    .replace(/\b[a-z]/g, letter => letter.toUpperCase());

  return titleCased
    .split(/\s+/)
    .map(token => {
      if (UPPERCASE_FILE_NAME_TOKENS.has(token.toUpperCase())) return token.toUpperCase();
      if (/^[ivxlcdm]+$/i.test(token) && token.length <= 6) return token.toUpperCase();
      return token;
    })
    .join(' ');
}

function buildMonthYearSuffix(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = String(now.getFullYear());
  return `${month}${year}`;
}

export function buildOutputFileName(job, now = new Date()) {
  const company = toTitleCase(sanitizeFileNamePart(job?.company)) || 'Company';
  const role = toTitleCase(sanitizeFileNamePart(job?.role)) || 'Role';
  const monthYear = buildMonthYearSuffix(now);
  return `${company} - ${role} - Cover Letter - ${monthYear}.docx`;
}

export function buildResumeOutputFileName(job, now = new Date()) {
  const company = toTitleCase(sanitizeFileNamePart(job?.company)) || 'Company';
  const role = toTitleCase(sanitizeFileNamePart(job?.role)) || 'Role';
  const monthYear = buildMonthYearSuffix(now);
  return `${company} - ${role} - Resume - ${monthYear}.docx`;
}

function buildJobBundleName(job) {
  const company = sanitizeFileNamePart(job?.company) || 'company';
  const role = sanitizeFileNamePart(job?.role) || 'role';
  return `${company}-${role}-application-pack.zip`;
}

function buildSampleSourceKey(sampleId) {
  return `${SAMPLE_SOURCE_KEY_PREFIX}:${String(sampleId || '')}`;
}

function normalizePersistedJob(rawJob) {
  const source = rawJob && typeof rawJob === 'object' ? rawJob : {};
  const id = String(source.id || createJobId());
  const storage = source.storage && typeof source.storage === 'object' ? source.storage : {};

  const status = String(source.status || 'queued').toLowerCase();
  const validStatuses = new Set([
    'queued',
    'preparing',
    'tailoring',
    'applying',
    'done',
    'partial',
    'failed',
    'retry'
  ]);

  return {
    id,
    company: String(source.company || '').trim(),
    role: String(source.role || '').trim(),
    description: String(source.description || '').trim(),
    status: validStatuses.has(status) ? status : 'queued',
    recommendation: String(source.recommendation || '').trim(),
    coverLetterOperationCount: Number(source.coverLetterOperationCount || 0),
    resumeOperationCount: Number(source.resumeOperationCount || 0),
    operationCount: Number(source.operationCount || 0),
    failedOperationCount: Number(source.failedOperationCount || 0),
    failedOperations: Array.isArray(source.failedOperations) ? source.failedOperations.map(String) : [],
    validationError: String(source.validationError || ''),
    runtime: {
      error: null
    },
    storage: {
      resultKey: String(storage.resultKey || `${id}:result`),
      resumeResultKey: String(storage.resumeResultKey || `${id}:resume-result`),
      detailsKey: String(storage.detailsKey || `${id}:details`)
    }
  };
}

function getSelectedJob() {
  return state.jobs.find(job => job.id === state.selectedJobId) || null;
}

function hasBaseDocument() {
  return Boolean(state.baseDocument.fileName);
}

function hasResumeDocument() {
  return Boolean(state.resumeDocument.fileName);
}

function hasCompletedJobs() {
  return state.jobs.some(job => job.status === 'done' || job.status === 'partial');
}

function getStoredApiKey() {
  try {
    return localStorage.getItem(STORAGE_KEYS.GEMINI_API_KEY) || '';
  } catch {
    return '';
  }
}

function setStoredApiKey(apiKey) {
  try {
    if (apiKey) localStorage.setItem(STORAGE_KEYS.GEMINI_API_KEY, apiKey);
    else localStorage.removeItem(STORAGE_KEYS.GEMINI_API_KEY);
  } catch {
    // Ignore storage errors.
  }
}

function getStoredPromptSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PROMPT_SETTINGS);
    if (!raw) return { ...state.promptSettings };
    const parsed = JSON.parse(raw);
    return {
      ...state.promptSettings,
      model: normalizeGeminiModel(parsed?.model)
    };
  } catch {
    return { ...state.promptSettings };
  }
}

function setStoredPromptSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEYS.PROMPT_SETTINGS, JSON.stringify({
      model: normalizeGeminiModel(settings?.model)
    }));
  } catch {
    // Ignore storage errors.
  }
}

function getStoredEditMode() {
  try {
    const mode = localStorage.getItem(STORAGE_KEYS.EDIT_MODE);
    if (mode === 'direct') return 'direct';
    if (mode === 'track') return 'track';
    return 'track';
  } catch {
    return 'track';
  }
}

function setStoredEditMode(mode) {
  try {
    localStorage.setItem(STORAGE_KEYS.EDIT_MODE, mode === 'track' ? 'track' : 'direct');
  } catch {
    // Ignore storage errors.
  }
}

function getStoredTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEYS.THEME);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

function setStoredTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEYS.THEME, theme === 'dark' ? 'dark' : 'light');
  } catch {
    // Ignore storage errors.
  }
}

function applyTheme(refs, theme) {
  const isDark = theme === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  refs.themeToggleBtn.textContent = isDark ? '☀' : '🌙';
  refs.themeToggleBtn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
  refs.themeToggleBtn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  refs.themeToggleBtn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

function getStoredIncludeComments() {
  try {
    return localStorage.getItem(STORAGE_KEYS.INCLUDE_COMMENTS) === '1';
  } catch {
    return false;
  }
}

function setStoredIncludeComments(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEYS.INCLUDE_COMMENTS, '1');
    else localStorage.removeItem(STORAGE_KEYS.INCLUDE_COMMENTS);
  } catch {
    // Ignore storage errors.
  }
}

function getApiKeyFingerprint(apiKey) {
  const normalized = String(apiKey || '').trim();
  if (!normalized) return '';
  const start = normalized.slice(0, 6);
  const end = normalized.slice(-4);
  return `${start}:${normalized.length}:${end}`;
}

function getStoredApiKeyValidation() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.API_KEY_VALIDATION);
    if (!raw) return { fingerprint: '', validatedAt: '' };
    const parsed = JSON.parse(raw);
    return {
      fingerprint: String(parsed?.fingerprint || '').trim(),
      validatedAt: String(parsed?.validatedAt || '').trim()
    };
  } catch {
    return { fingerprint: '', validatedAt: '' };
  }
}

function setStoredApiKeyValidation(apiKey) {
  const fingerprint = getApiKeyFingerprint(apiKey);
  if (!fingerprint) {
    clearStoredApiKeyValidation();
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEYS.API_KEY_VALIDATION, JSON.stringify({
      fingerprint,
      validatedAt: new Date().toISOString()
    }));
  } catch {
    // Ignore storage errors.
  }
}

function clearStoredApiKeyValidation() {
  try {
    localStorage.removeItem(STORAGE_KEYS.API_KEY_VALIDATION);
  } catch {
    // Ignore storage errors.
  }
}

function hasValidatedApiKey(apiKey) {
  const fingerprint = getApiKeyFingerprint(apiKey);
  if (!fingerprint) return false;
  const stored = getStoredApiKeyValidation();
  return stored.fingerprint === fingerprint;
}

function getStoredOnboardingDismissed() {
  try {
    return localStorage.getItem(STORAGE_KEYS.ONBOARDING_DISMISSED) === '1';
  } catch {
    return false;
  }
}

function setStoredOnboardingDismissed(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEYS.ONBOARDING_DISMISSED, '1');
    else localStorage.removeItem(STORAGE_KEYS.ONBOARDING_DISMISSED);
  } catch {
    // Ignore storage errors.
  }
}

function getStoredSidebarWidth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SIDEBAR_WIDTH);
    const parsed = Number.parseInt(String(raw || ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function setStoredSidebarWidth(width) {
  try {
    const parsed = Number.parseInt(String(width || ''), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      localStorage.setItem(STORAGE_KEYS.SIDEBAR_WIDTH, String(parsed));
    }
  } catch {
    // Ignore storage errors.
  }
}

function isCompactLayout() {
  return globalThis.matchMedia?.('(max-width: 1280px)')?.matches || false;
}

function getSidebarWidthBounds() {
  const min = 280;
  const max = Math.max(min + 20, Math.min(620, Math.floor((globalThis.innerWidth || 1280) * 0.56)));
  return { min, max };
}

function clampSidebarWidth(width) {
  const parsed = Number.parseInt(String(width || ''), 10);
  if (!Number.isFinite(parsed)) return 340;
  const { min, max } = getSidebarWidthBounds();
  return Math.max(min, Math.min(max, parsed));
}

function applySidebarWidth(refs, width, options = {}) {
  const persist = Boolean(options?.persist);

  if (isCompactLayout()) {
    refs.workspace.style.removeProperty('--sidebar-width');
    return;
  }

  const clamped = clampSidebarWidth(width);
  refs.workspace.style.setProperty('--sidebar-width', `${clamped}px`);
  refs.sidebarResizeHandle.setAttribute('aria-valuemin', String(getSidebarWidthBounds().min));
  refs.sidebarResizeHandle.setAttribute('aria-valuemax', String(getSidebarWidthBounds().max));
  refs.sidebarResizeHandle.setAttribute('aria-valuenow', String(clamped));

  if (persist) {
    setStoredSidebarWidth(clamped);
  }
}

function wireSidebarResizer(refs) {
  const getCurrentSidebarWidth = () => Math.round(refs.sidebar.getBoundingClientRect().width);

  refs.sidebarResizeHandle.addEventListener('pointerdown', event => {
    if (isCompactLayout()) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = getCurrentSidebarWidth();
    document.body.classList.add('is-resizing');

    const onMove = moveEvent => {
      const delta = moveEvent.clientX - startX;
      applySidebarWidth(refs, startWidth + delta);
    };

    const onUp = () => {
      document.body.classList.remove('is-resizing');
      globalThis.removeEventListener('pointermove', onMove);
      globalThis.removeEventListener('pointerup', onUp);
      applySidebarWidth(refs, getCurrentSidebarWidth(), { persist: true });
    };

    globalThis.addEventListener('pointermove', onMove);
    globalThis.addEventListener('pointerup', onUp, { once: true });
  });

  refs.sidebarResizeHandle.addEventListener('keydown', event => {
    if (isCompactLayout()) return;

    const current = getCurrentSidebarWidth();
    const step = event.shiftKey ? 36 : 14;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      applySidebarWidth(refs, current - step, { persist: true });
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      applySidebarWidth(refs, current + step, { persist: true });
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      applySidebarWidth(refs, getSidebarWidthBounds().min, { persist: true });
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      applySidebarWidth(refs, getSidebarWidthBounds().max, { persist: true });
    }
  });

  const storedWidth = getStoredSidebarWidth();
  applySidebarWidth(refs, storedWidth || 340);

  globalThis.addEventListener('resize', () => {
    if (isCompactLayout()) {
      refs.workspace.style.removeProperty('--sidebar-width');
      return;
    }
    applySidebarWidth(refs, getStoredSidebarWidth() || getCurrentSidebarWidth());
  });
}

function populateModelSelect(refs) {
  refs.modelSelect.replaceChildren();
  for (const optionDef of GEMINI_MODEL_OPTIONS) {
    const option = document.createElement('option');
    option.value = optionDef.value;
    option.textContent = optionDef.label;
    refs.modelSelect.appendChild(option);
  }
}

function refreshControls(refs) {
  const hasApiKey = Boolean(refs.apiKeyInput.value.trim());
  const selectedJob = getSelectedJob();
  const hasCompletedSelection = Boolean(selectedJob && ['done', 'partial'].includes(String(selectedJob.status || '')));
  const canAcceptCoverLetter = Boolean(hasCompletedSelection && Number(selectedJob?.coverLetterOperationCount || 0) > 0);
  const canAcceptResume = Boolean(hasCompletedSelection && Number(selectedJob?.resumeOperationCount || 0) > 0);
  const canAcceptPreviewChanges = state.previewType === 'resume' ? canAcceptResume : canAcceptCoverLetter;
  const canRunAll = hasApiKey && hasBaseDocument() && state.jobs.length > 0 && !state.isRunning;
  const canRunSelected = hasApiKey && hasBaseDocument() && Boolean(selectedJob) && !state.isRunning;
  const canExportSelected = Boolean(selectedJob && ['done', 'partial'].includes(selectedJob.status));
  const canExportAll = hasCompletedJobs();

  setActionEnabled(refs, 'runAllBtn', canRunAll);
  setActionEnabled(refs, 'runMenuBtn', canRunAll);
  setActionEnabled(refs, 'runSelectedBtn', canRunSelected);
  setActionEnabled(refs, 'downloadBtn', canExportSelected);
  setActionEnabled(refs, 'downloadAllBtn', canExportAll);
  setActionEnabled(refs, 'downloadMenuBtn', canExportAll);
  setActionEnabled(refs, 'acceptAllChangesBtn', canAcceptPreviewChanges && !state.isRunning);
  setActionEnabled(refs, 'clearSamplesBtn', state.sampleDocuments.length > 0);
  setActionEnabled(refs, 'clearApplicationsBtn', state.jobs.length > 0);
}

function closeActionMenu(refs, type) {
  const menuKey = type === 'run' ? 'runMenu' : 'downloadMenu';
  const btnKey = type === 'run' ? 'runMenuBtn' : 'downloadMenuBtn';
  refs[menuKey].hidden = true;
  refs[btnKey].setAttribute('aria-expanded', 'false');
}

function closeAllActionMenus(refs) {
  closeActionMenu(refs, 'run');
  closeActionMenu(refs, 'download');
}

function toggleActionMenu(refs, type) {
  const menuKey = type === 'run' ? 'runMenu' : 'downloadMenu';
  const btnKey = type === 'run' ? 'runMenuBtn' : 'downloadMenuBtn';
  const otherType = type === 'run' ? 'download' : 'run';
  const menu = refs[menuKey];
  const button = refs[btnKey];
  const shouldOpen = menu.hidden;

  closeActionMenu(refs, otherType);
  menu.hidden = !shouldOpen;
  button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

function openSettingsModal(refs) {
  refs.settingsModal.hidden = false;
}

function closeSettingsModal(refs) {
  refs.settingsModal.hidden = true;
}

function getOnboardingProgress(refs) {
  const hasApiKey = Boolean(refs.apiKeyInput.value.trim());
  const isApiValidated = hasApiKey && hasValidatedApiKey(refs.apiKeyInput.value);
  const steps = {
    api: isApiValidated,
    docs: hasBaseDocument(),
    job: state.jobs.length > 0,
    generate: hasCompletedJobs()
  };
  const completeCount = ONBOARDING_STEPS.filter(step => steps[step]).length;
  const nextStep = ONBOARDING_STEPS.find(step => !steps[step]) || null;
  return {
    steps,
    completeCount,
    totalCount: ONBOARDING_STEPS.length,
    allComplete: completeCount === ONBOARDING_STEPS.length,
    nextStep
  };
}

function setOnboardingStep(refs, stepKey, isComplete) {
  const map = {
    api: ['onboardingStepApi', 'onboardingStepApiStatus'],
    docs: ['onboardingStepDocs', 'onboardingStepDocsStatus'],
    job: ['onboardingStepJob', 'onboardingStepJobStatus'],
    generate: ['onboardingStepGenerate', 'onboardingStepGenerateStatus']
  };
  const [itemRef, statusRef] = map[stepKey] || [];
  if (!itemRef || !statusRef) return;
  refs[itemRef].classList.toggle('complete', Boolean(isComplete));
  refs[statusRef].textContent = isComplete ? 'Done' : 'Pending';
}

function refreshOnboarding(refs) {
  const progress = getOnboardingProgress(refs);
  const isLockedOpen = !progress.allComplete;

  setOnboardingStep(refs, 'api', progress.steps.api);
  setOnboardingStep(refs, 'docs', progress.steps.docs);
  setOnboardingStep(refs, 'job', progress.steps.job);
  setOnboardingStep(refs, 'generate', progress.steps.generate);

  const hints = {
    api: 'Open Settings, add your Gemini key, then click Save Key.',
    docs: 'Upload your base cover letter (.docx) in Source Documents.',
    job: 'Paste a job description and click Add Job.',
    generate: 'Click Generate to produce your first tailored output.'
  };
  const nextHint = progress.nextStep ? hints[progress.nextStep] : 'All quick-start steps are complete.';
  const lockHint = isLockedOpen ? ' This guide stays visible until all steps are complete.' : '';
  refs.onboardingHint.textContent = `${progress.completeCount}/${progress.totalCount} complete. ${nextHint}${lockHint}`;
  refs.onboardingPrimaryBtn.textContent = progress.allComplete ? 'Close Guide' : 'Take Me To Next Step';
  refs.onboardingPrimaryBtn.disabled = state.isValidatingApiKey;
  refs.onboardingCloseBtn.hidden = isLockedOpen;
  refs.onboardingDismissBtn.hidden = isLockedOpen;
  refs.onboardingBackdrop.hidden = true;

  if (isLockedOpen) {
    state.onboarding.dismissed = false;
    setStoredOnboardingDismissed(false);
  }

  const shouldShow = isLockedOpen || state.onboarding.forcedOpen;
  refs.onboardingModal.hidden = !shouldShow;
}

function openOnboardingModal(refs, force = false) {
  state.onboarding.forcedOpen = Boolean(force);
  refs.onboardingModal.hidden = false;
  refreshOnboarding(refs);
}

function closeOnboardingModal(refs, options = {}) {
  const progress = getOnboardingProgress(refs);
  if (!progress.allComplete) {
    state.onboarding.forcedOpen = false;
    refs.onboardingModal.hidden = false;
    return;
  }

  const dismiss = Boolean(options?.dismiss);
  if (dismiss) {
    state.onboarding.dismissed = true;
    setStoredOnboardingDismissed(true);
  }
  state.onboarding.forcedOpen = false;
  refs.onboardingModal.hidden = true;
}

function jumpToElement(element) {
  if (!element || typeof element.scrollIntoView !== 'function') return;
  element.scrollIntoView({
    behavior: 'smooth',
    block: 'center'
  });
}

function pulseGuideTarget(element, options = {}) {
  if (!(element instanceof Element)) return;

  const variant = options?.variant === 'section' ? 'section' : 'control';
  const className = variant === 'section' ? 'guide-pulse-section' : 'guide-pulse-control';
  const durationMs = Number(options?.durationMs ?? 1300);

  element.classList.remove('guide-pulse-section', 'guide-pulse-control');
  // Restart animation when pulsing the same target repeatedly.
  void element.offsetWidth;
  element.classList.add(className);

  if (!Number.isFinite(durationMs) || durationMs <= 0) return;

  const existingTimer = element.__guidePulseTimer;
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  element.__guidePulseTimer = setTimeout(() => {
    element.classList.remove('guide-pulse-section', 'guide-pulse-control');
    element.__guidePulseTimer = null;
  }, durationMs);
}

function handleOnboardingPrimaryAction(refs) {
  const progress = getOnboardingProgress(refs);
  if (progress.allComplete) {
    closeOnboardingModal(refs, { dismiss: true });
    return;
  }

  if (progress.nextStep === 'api') {
    openSettingsModal(refs);
    refs.apiKeyInput.focus();
    pulseGuideTarget(refs.apiKeyInput);
    setStatusBanner(refs, 'Save your Gemini API key to continue (validation runs automatically).', 'info');
    return;
  }

  if (progress.nextStep === 'docs') {
    jumpToElement(refs.sourcePanel);
    pulseGuideTarget(refs.sourcePanel, { variant: 'section', durationMs: 1700 });
    setStatusBanner(refs, 'Upload your base cover letter to continue.', 'info');
    return;
  }

  if (progress.nextStep === 'job') {
    jumpToElement(refs.jobInputPanel);
    refs.jobDescriptionInput.focus();
    pulseGuideTarget(refs.jobInputPanel, { variant: 'section', durationMs: 1700 });
    setStatusBanner(refs, 'Add one job description to continue.', 'info');
    return;
  }

  const targetRunButton = refs.runSelectedBtn.disabled ? refs.runAllBtn : refs.runSelectedBtn;
  jumpToElement(targetRunButton);
  targetRunButton.focus();
  pulseGuideTarget(targetRunButton);
  setStatusBanner(refs, 'Click Generate to create your first tailored output.', 'info');
}

function getApiValidationFailureMessage(error) {
  const rawMessage = String(error?.message || 'Unknown error');
  if (/401|403|permission_denied|api key not valid|invalid api key/i.test(rawMessage)) {
    return 'Invalid API key or this API key does not have Gemini API access.';
  }
  if (/429|resource_exhausted|quota|rate/i.test(rawMessage)) {
    return 'Key is valid, but quota/rate limits are currently exceeded.';
  }
  return rawMessage.length > 200 ? `${rawMessage.slice(0, 197)}...` : rawMessage;
}

async function validateApiKeyInput(refs) {
  if (state.isValidatingApiKey) return;

  const apiKey = refs.apiKeyInput.value.trim();
  if (!apiKey) {
    setStatusBanner(refs, 'Enter a Gemini API key first.', 'warn');
    return;
  }

  state.isValidatingApiKey = true;
  refreshControls(refs);
  refreshOnboarding(refs);

  try {
    const result = await validateGeminiApiKey({
      apiKey,
      model: state.promptSettings.model
    });
    setStoredApiKey(apiKey);
    setStoredApiKeyValidation(apiKey);
    if (result.selectedModelAvailable) {
      setStatusBanner(refs, `Gemini API key validated. Selected model: ${result.model}.`, 'success');
    } else {
      setStatusBanner(
        refs,
        `Gemini API key validated, but ${result.model} is not available for this key. Choose another model in Settings.`,
        'warn'
      );
    }
  } catch (error) {
    setStatusBanner(refs, `API key validation failed: ${getApiValidationFailureMessage(error)}`, 'error');
  } finally {
    state.isValidatingApiKey = false;
    renderUi(refs);
  }
}

function renderUi(refs) {
  const selectedJob = getSelectedJob();
  const canPreviewResume = hasResumeDocument() || Boolean(selectedJob?.resumeOperationCount > 0);
  if (state.previewType === 'resume' && !canPreviewResume) {
    state.previewType = 'coverLetter';
  }

  renderJobList(refs, state.jobs, state.selectedJobId);
  renderSelectedJob(refs, selectedJob);
  setPreviewTypeButtons(refs, state.previewType);

  refs.baseFileMeta.textContent = state.baseDocument.fileName
    ? `Base: ${state.baseDocument.fileName}`
    : 'No base letter uploaded.';

  refs.resumeFileMeta.textContent = state.resumeDocument.fileName
    ? `Resume: ${state.resumeDocument.fileName}`
    : 'No resume uploaded.';

  refs.samplesFileMeta.textContent = state.sampleDocuments.length > 0
    ? `${state.sampleDocuments.length} sample letter${state.sampleDocuments.length === 1 ? '' : 's'} loaded.`
    : 'No sample letters uploaded.';

  refs.previewResumeBtn.disabled = !canPreviewResume;

  refreshControls(refs);
  refreshOnboarding(refs);
}

function getFileFromBlob(blob, fileName) {
  return {
    name: fileName,
    async arrayBuffer() {
      return blob.arrayBuffer();
    }
  };
}

async function loadParagraphsFromBlob(blob, fileName) {
  const source = getFileFromBlob(blob, fileName || 'document.docx');
  const parsed = await ingestDocxFile(source);
  return parsed.paragraphs;
}

async function persistSessionState() {
  if (!state.store) return;

  const snapshot = {
    baseDocument: {
      fileName: String(state.baseDocument.fileName || '').trim()
    },
    resumeDocument: {
      fileName: String(state.resumeDocument.fileName || '').trim()
    },
    sampleDocuments: state.sampleDocuments.map(sample => ({
      id: String(sample.id || ''),
      fileName: String(sample.fileName || '').trim(),
      storageKey: String(sample.storageKey || buildSampleSourceKey(sample.id))
    })),
    jobs: state.jobs.map(job => ({
      id: String(job.id || ''),
      company: String(job.company || '').trim(),
      role: String(job.role || '').trim(),
      description: String(job.description || '').trim(),
      status: String(job.status || 'queued').trim(),
      recommendation: String(job.recommendation || '').trim(),
      coverLetterOperationCount: Number(job.coverLetterOperationCount || 0),
      resumeOperationCount: Number(job.resumeOperationCount || 0),
      operationCount: Number(job.operationCount || 0),
      failedOperationCount: Number(job.failedOperationCount || 0),
      failedOperations: Array.isArray(job.failedOperations) ? job.failedOperations.map(String) : [],
      validationError: String(job.validationError || ''),
      storage: {
        resultKey: String(job?.storage?.resultKey || ''),
        resumeResultKey: String(job?.storage?.resumeResultKey || ''),
        detailsKey: String(job?.storage?.detailsKey || '')
      }
    })),
    selectedJobId: state.selectedJobId ? String(state.selectedJobId) : '',
    previewType: state.previewType === 'resume' ? 'resume' : 'coverLetter'
  };

  try {
    await state.store.putJson(SESSION_STATE_KEY, snapshot);
  } catch (error) {
    console.warn('[Application Station] Failed to persist session state:', error?.message || String(error));
  }
}

async function restoreSessionState() {
  if (!state.store) return { restored: false };

  let snapshot = null;
  try {
    snapshot = await state.store.getJson(SESSION_STATE_KEY);
  } catch (error) {
    console.warn('[Application Station] Failed to read persisted session state:', error?.message || String(error));
    return { restored: false };
  }

  if (!snapshot || typeof snapshot !== 'object') {
    return { restored: false };
  }

  state.jobs = (Array.isArray(snapshot.jobs) ? snapshot.jobs : []).map(normalizePersistedJob);
  state.selectedJobId = String(snapshot.selectedJobId || '').trim() || null;
  state.previewType = snapshot.previewType === 'resume' ? 'resume' : 'coverLetter';

  const baseFileName = String(snapshot?.baseDocument?.fileName || '').trim();
  const baseBlob = await state.store.getBlob(BASE_SOURCE_KEY);
  if (baseBlob) {
    try {
      state.baseDocument.fileName = baseFileName || 'base-cover-letter.docx';
      state.baseDocument.paragraphs = await loadParagraphsFromBlob(baseBlob, state.baseDocument.fileName);
    } catch (error) {
      console.warn('[Application Station] Failed to restore base cover letter:', error?.message || String(error));
      state.baseDocument.fileName = '';
      state.baseDocument.paragraphs = [];
    }
  }

  const resumeFileName = String(snapshot?.resumeDocument?.fileName || '').trim();
  const resumeBlob = await state.store.getBlob(RESUME_SOURCE_KEY);
  if (resumeBlob) {
    try {
      state.resumeDocument.fileName = resumeFileName || 'resume.docx';
      state.resumeDocument.paragraphs = await loadParagraphsFromBlob(resumeBlob, state.resumeDocument.fileName);
    } catch (error) {
      console.warn('[Application Station] Failed to restore resume:', error?.message || String(error));
      state.resumeDocument.fileName = '';
      state.resumeDocument.paragraphs = [];
    }
  }

  state.sampleDocuments = [];
  for (const rawSample of Array.isArray(snapshot.sampleDocuments) ? snapshot.sampleDocuments : []) {
    const sampleId = String(rawSample?.id || createJobId());
    const fileName = String(rawSample?.fileName || '').trim() || 'sample.docx';
    const storageKey = String(rawSample?.storageKey || buildSampleSourceKey(sampleId));
    const sampleBlob = await state.store.getBlob(storageKey);
    if (!sampleBlob) continue;

    try {
      const paragraphs = await loadParagraphsFromBlob(sampleBlob, fileName);
      state.sampleDocuments.push({
        id: sampleId,
        fileName,
        storageKey,
        paragraphs
      });
    } catch (error) {
      console.warn('[Application Station] Failed to restore sample letter:', error?.message || String(error));
    }
  }

  if (!state.jobs.some(job => job.id === state.selectedJobId)) {
    state.selectedJobId = state.jobs[0]?.id || null;
  }

  return {
    restored: Boolean(
      state.baseDocument.fileName
      || state.resumeDocument.fileName
      || state.sampleDocuments.length > 0
      || state.jobs.length > 0
    ),
    jobCount: state.jobs.length
  };
}

function createPreviewSkeletonPlaceholder() {
  const shell = document.createElement('div');
  shell.className = 'preview-skeleton-shell';

  const page = document.createElement('div');
  page.className = 'preview-skeleton-page';

  const topRule = document.createElement('div');
  topRule.className = 'preview-skeleton-rule';
  page.appendChild(topRule);

  const groups = [
    [82, 58, 92, 90, 76],
    [88, 94, 78, 83],
    [91, 73, 86, 80, 62],
    [44, 68, 59]
  ];

  for (const widths of groups) {
    const group = document.createElement('div');
    group.className = 'preview-skeleton-group';
    for (const width of widths) {
      const line = document.createElement('span');
      line.className = 'preview-skeleton-line';
      line.style.setProperty('--line-width', `${width}%`);
      group.appendChild(line);
    }
    page.appendChild(group);
  }

  const signatureBlock = document.createElement('div');
  signatureBlock.className = 'preview-skeleton-signature';
  page.appendChild(signatureBlock);

  shell.appendChild(page);
  return shell;
}

async function renderSelectedPreview(refs) {
  const selectedJob = getSelectedJob();
  const isResumePreview = state.previewType === 'resume';
  const selectedCoverLetterBlob = selectedJob
    ? await state.store.getBlob(selectedJob.storage.resultKey)
    : null;
  const selectedResumeBlob = selectedJob
    ? await state.store.getBlob(selectedJob.storage.resumeResultKey)
    : null;

  const previewBlob = isResumePreview
    ? (selectedResumeBlob || await state.store.getBlob(RESUME_SOURCE_KEY))
    : (selectedCoverLetterBlob || await state.store.getBlob(BASE_SOURCE_KEY));

  if (!previewBlob) {
    refs.previewHost.classList.add('preview-host-skeleton');
    refs.previewHost.replaceChildren(createPreviewSkeletonPlaceholder());
    setPreviewStatus(
      refs,
      isResumePreview ? 'Upload a resume to preview resume edits.' : 'Upload a base cover letter to preview.',
      'info'
    );
    return;
  }

  try {
    refs.previewHost.classList.remove('preview-host-skeleton');
    await renderPreviewFromBlob(previewBlob, refs.previewHost, message => setPreviewStatus(refs, message, 'info'));

    const formatOperationsMessage = value => {
      const parsed = Number.parseInt(String(value ?? 0), 10);
      const count = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
      return `${count} operation${count === 1 ? '' : 's'} made.`;
    };

    if (isResumePreview) {
      const operationsMessage = selectedJob
        ? ` ${formatOperationsMessage(selectedResumeBlob ? selectedJob.resumeOperationCount : 0)}`
        : '';
      setPreviewStatus(
        refs,
        `${selectedResumeBlob ? 'Showing tailored resume preview.' : 'Showing base resume preview.'}${operationsMessage}`,
        'success'
      );
    } else {
      const operationsMessage = selectedJob
        ? ` ${formatOperationsMessage(selectedCoverLetterBlob ? selectedJob.coverLetterOperationCount : 0)}`
        : '';
      setPreviewStatus(
        refs,
        `${selectedCoverLetterBlob ? 'Showing tailored cover letter preview.' : 'Showing base cover letter preview.'}${operationsMessage}`,
        'success'
      );
    }
  } catch (error) {
    refs.previewHost.classList.remove('preview-host-skeleton');
    setPreviewStatus(refs, `Preview unavailable: ${error?.message || String(error)}`, 'error');
  }
}

async function setBaseFile(refs, file) {
  if (!file) return;

  const docxFiles = filterDocxFiles([file]);
  if (docxFiles.length === 0) {
    setStatusBanner(refs, 'Base document must be a .docx file.', 'error');
    return;
  }

  const picked = docxFiles[0];
  const parsed = await ingestDocxFile(picked);
  await state.store.putBlob(BASE_SOURCE_KEY, picked);

  state.baseDocument.fileName = picked.name;
  state.baseDocument.paragraphs = parsed.paragraphs;
  await persistSessionState();

  setStatusBanner(refs, `Loaded base cover letter: ${picked.name}`, 'success');
  renderUi(refs);
  await renderSelectedPreview(refs);
}

async function setResumeFile(refs, file) {
  if (!file) return;

  const docxFiles = filterDocxFiles([file]);
  if (docxFiles.length === 0) {
    setStatusBanner(refs, 'Resume must be a .docx file.', 'error');
    return;
  }

  const picked = docxFiles[0];
  await state.store.putBlob(RESUME_SOURCE_KEY, picked);

  const paragraphs = await loadParagraphsFromBlob(picked, picked.name);
  state.resumeDocument.fileName = picked.name;
  state.resumeDocument.paragraphs = paragraphs;
  await persistSessionState();

  setStatusBanner(refs, `Loaded resume source: ${picked.name}`, 'success');
  renderUi(refs);
}

async function addSampleFiles(refs, files) {
  const docxFiles = filterDocxFiles(files);
  if (docxFiles.length === 0) {
    setStatusBanner(refs, 'Sample letters must be .docx files.', 'error');
    return;
  }

  for (const file of docxFiles) {
    const paragraphs = await loadParagraphsFromBlob(file, file.name);
    const sampleId = createJobId();
    const storageKey = buildSampleSourceKey(sampleId);
    await state.store.putBlob(storageKey, file);
    state.sampleDocuments.push({
      id: sampleId,
      fileName: file.name,
      storageKey,
      paragraphs
    });
  }
  await persistSessionState();

  setStatusBanner(refs, `Loaded ${docxFiles.length} sample letter(s) for style context.`, 'success');
  renderUi(refs);
}

async function clearSampleLetters(refs) {
  if (state.sampleDocuments.length === 0) {
    setStatusBanner(refs, 'No sample letters to clear.', 'warn');
    return;
  }

  for (const sample of state.sampleDocuments) {
    const storageKey = sample?.storageKey || buildSampleSourceKey(sample?.id);
    await state.store.remove(storageKey);
  }

  state.sampleDocuments = [];
  await persistSessionState();
  setStatusBanner(refs, 'Cleared all sample letters.', 'success');
  renderUi(refs);
}

async function addSingleJobFromInputs(refs) {
  const company = refs.jobCompanyInput.value.trim();
  const role = refs.jobRoleInput.value.trim();
  const description = refs.jobDescriptionInput.value.trim();

  if (!description) {
    setStatusBanner(refs, 'Add a job description before creating a job.', 'warn');
    return;
  }

  const newJob = createCoverLetterJob({ company, role, description });
  state.jobs.push(newJob);

  if (!state.selectedJobId) {
    state.selectedJobId = newJob.id;
  }
  await persistSessionState();

  refs.jobCompanyInput.value = '';
  refs.jobRoleInput.value = '';
  refs.jobDescriptionInput.value = '';

  setStatusBanner(refs, `Added job: ${formatJobDisplayName(newJob)}`, 'success');
  renderUi(refs);
  await renderSelectedPreview(refs);
}

function getContextText(paragraphs) {
  return (Array.isArray(paragraphs) ? paragraphs : [])
    .map(p => p.text)
    .join('\n');
}

function stripCommentOperations(operations) {
  return (Array.isArray(operations) ? operations : []).filter(operation => operation?.type !== 'comment');
}

async function clearTailoredApplications(refs) {
  if (state.jobs.length === 0) {
    setStatusBanner(refs, 'No tailored applications to remove.', 'warn');
    return;
  }

  for (const job of state.jobs) {
    if (job?.storage?.resultKey) await state.store.remove(job.storage.resultKey);
    if (job?.storage?.resumeResultKey) await state.store.remove(job.storage.resumeResultKey);
    if (job?.storage?.detailsKey) await state.store.remove(job.storage.detailsKey);
  }

  state.jobs = [];
  state.selectedJobId = null;
  state.previewType = 'coverLetter';
  await persistSessionState();

  setStatusBanner(refs, 'Removed all tailored applications.', 'success');
  renderUi(refs);
  await renderSelectedPreview(refs);
}

async function removeTailoredApplicationById(refs, jobId) {
  const normalizedId = String(jobId || '').trim();
  if (!normalizedId) return;
  if (state.isRunning) {
    setStatusBanner(refs, 'Wait for generation to finish before removing an application.', 'warn');
    return;
  }

  const job = state.jobs.find(item => item.id === normalizedId);
  if (!job) return;

  if (job?.storage?.resultKey) await state.store.remove(job.storage.resultKey);
  if (job?.storage?.resumeResultKey) await state.store.remove(job.storage.resumeResultKey);
  if (job?.storage?.detailsKey) await state.store.remove(job.storage.detailsKey);

  state.jobs = state.jobs.filter(item => item.id !== normalizedId);
  if (state.selectedJobId === normalizedId) {
    state.selectedJobId = state.jobs[0]?.id || null;
  }

  await persistSessionState();
  setStatusBanner(refs, `Removed application: ${formatJobDisplayName(job)}`, 'success');
  renderUi(refs);
  await renderSelectedPreview(refs);
}

async function acceptAllPreviewRedlines(refs) {
  if (state.isRunning) {
    setStatusBanner(refs, 'Wait for generation to finish before accepting changes.', 'warn');
    return;
  }

  const selectedJob = getSelectedJob();
  if (!selectedJob) {
    setStatusBanner(refs, 'Select a tailored application first.', 'warn');
    return;
  }

  const isResumePreview = state.previewType === 'resume';
  const storageKey = isResumePreview
    ? selectedJob.storage.resumeResultKey
    : selectedJob.storage.resultKey;
  if (!storageKey) {
    setStatusBanner(refs, 'No generated preview document is available.', 'warn');
    return;
  }

  const sourceBlob = await state.store.getBlob(storageKey);
  if (!sourceBlob) {
    setStatusBanner(
      refs,
      isResumePreview
        ? 'No tailored resume exists for this application yet.'
        : 'No tailored cover letter exists for this application yet.',
      'warn'
    );
    return;
  }

  try {
    setStatusBanner(
      refs,
      `Accepting tracked changes for ${isResumePreview ? 'resume' : 'cover letter'} preview...`,
      'info'
    );

    const zip = await loadDocxZipFromBlob(sourceBlob);
    const acceptance = await acceptAllTrackedChangesInZip({
      zip,
      allAuthors: true
    });

    if (!acceptance.hasChanges) {
      setStatusBanner(refs, 'No tracked changes found to accept in this preview.', 'warn');
      await renderSelectedPreview(refs);
      return;
    }

    const updatedBlob = await generateBlobFromZip(zip);
    await state.store.putBlob(storageKey, updatedBlob);
    await persistSessionState();

    renderUi(refs);
    await renderSelectedPreview(refs);
    setStatusBanner(
      refs,
      `Accepted ${acceptance.acceptedCount} tracked change${acceptance.acceptedCount === 1 ? '' : 's'} in the ${isResumePreview ? 'resume' : 'cover letter'}.`,
      'success'
    );
  } catch (error) {
    setStatusBanner(refs, `Accept-all failed: ${error?.message || String(error)}`, 'error');
  }
}

async function persistJobResult(job, coverLetterZip, resumeZip, details) {
  if (coverLetterZip) {
    const resultBlob = await generateBlobFromZip(coverLetterZip);
    await state.store.putBlob(job.storage.resultKey, resultBlob);
  }
  if (resumeZip) {
    const resumeBlob = await generateBlobFromZip(resumeZip);
    await state.store.putBlob(job.storage.resumeResultKey, resumeBlob);
  } else {
    await state.store.remove(job.storage.resumeResultKey);
  }
  await state.store.putJson(job.storage.detailsKey, details);
}

async function runJob(job, refs) {
  const apiKey = refs.apiKeyInput.value.trim();
  if (!apiKey) {
    setStatusBanner(refs, 'Enter a Gemini API key first.', 'warn');
    return;
  }
  if (!hasValidatedApiKey(apiKey)) {
    setStatusBanner(refs, 'Validate your Gemini API key in Settings before generating.', 'warn');
    openSettingsModal(refs);
    return;
  }

  if (!hasBaseDocument()) {
    setStatusBanner(refs, 'Upload a base cover letter first.', 'warn');
    return;
  }

  const baseBlob = await state.store.getBlob(BASE_SOURCE_KEY);
  if (!baseBlob) {
    setStatusBanner(refs, 'Base cover letter is missing from local storage.', 'error');
    return;
  }

  let coverLetterZip = null;
  let resumeZip = null;

  try {
    job.status = 'preparing';
    job.failedOperations = [];
    job.validationError = '';
    renderUi(refs);

    coverLetterZip = await loadDocxZipFromBlob(baseBlob);
    const baseParagraphs = Array.isArray(state.baseDocument.paragraphs) && state.baseDocument.paragraphs.length > 0
      ? state.baseDocument.paragraphs
      : await loadParagraphsFromBlob(baseBlob, state.baseDocument.fileName || 'base.docx');

    const resumeBlob = await state.store.getBlob(RESUME_SOURCE_KEY);
    const resumeParagraphs = Array.isArray(state.resumeDocument.paragraphs) && state.resumeDocument.paragraphs.length > 0
      ? state.resumeDocument.paragraphs
      : (resumeBlob ? await loadParagraphsFromBlob(resumeBlob, state.resumeDocument.fileName || 'resume.docx') : []);
    const hasResumeSource = Boolean(resumeBlob && resumeParagraphs.length > 0);
    if (hasResumeSource) {
      resumeZip = await loadDocxZipFromBlob(resumeBlob);
    }

    const baseLetterText = getContextText(baseParagraphs);
    const resumeText = getContextText(resumeParagraphs);
    const sampleLettersText = state.sampleDocuments
      .map(doc => getContextText(doc.paragraphs))
      .filter(Boolean)
      .join('\n\n---\n\n');

    job.status = 'tailoring';
    renderUi(refs);
    setStatusBanner(refs, `Tailoring for ${formatJobDisplayName(job)}...`, 'info');

    // Cover letter and resume tailoring are independent network calls — run them together.
    const [aiOutput, resumeAiOutput] = await Promise.all([
      generateTailoredCoverLetter({
        apiKey,
        model: state.promptSettings.model,
        promptSettings: state.promptSettings,
        baseLetterText,
        paragraphs: baseParagraphs,
        resumeText,
        sampleLettersText,
        job,
        mode: state.editMode,
        redlineCap: REDLINE_CAP
      }),
      (hasResumeSource && resumeZip)
        ? generateTailoredResume({
          apiKey,
          model: state.promptSettings.model,
          promptSettings: state.promptSettings,
          resumeText,
          paragraphs: resumeParagraphs,
          baseLetterText,
          sampleLettersText,
          job,
          mode: state.editMode,
          redlineCap: REDLINE_CAP
        })
        : Promise.resolve(null)
    ]);

    // Prefer cover-letter inferences, then fall back to resume inferences.
    if (!job.company) {
      job.company = aiOutput.inferredCompany || resumeAiOutput?.inferredCompany || '';
    }
    if (!job.role) {
      job.role = aiOutput.inferredRole || resumeAiOutput?.inferredRole || '';
    }

    const prepareOperations = (rawOperations, paragraphs) => {
      const reconciled = reconcileOperationsWithParagraphs(
        normalizeAndFilterOperations(rawOperations),
        paragraphs
      );
      return state.includeComments ? reconciled : stripCommentOperations(reconciled);
    };

    const coverLetterOperations = prepareOperations(aiOutput.operations, baseParagraphs);
    const resumeOperations = resumeAiOutput
      ? prepareOperations(resumeAiOutput.operations, resumeParagraphs)
      : [];

    job.status = 'applying';
    renderUi(refs);

    const emptyApply = { results: [], validation: { ok: true, error: null }, failures: [] };

    let coverLetterApply = emptyApply;
    if (coverLetterOperations.length > 0) {
      coverLetterApply = await applyOperationsInBatches({
        zip: coverLetterZip,
        operations: coverLetterOperations,
        author: AUTHOR_NAME,
        batchSize: OPERATION_BATCH_SIZE,
        generateRedlines: state.editMode === 'track',
        onProgress: progress => {
          setStatusBanner(
            refs,
            `Applying cover letter edits for ${formatJobDisplayName(job)} (${progress.completed}/${progress.totalOperations})...`,
            'info'
          );
        }
      });
    }

    let resumeApply = emptyApply;
    if (resumeOperations.length > 0 && resumeZip) {
      resumeApply = await applyOperationsInBatches({
        zip: resumeZip,
        operations: resumeOperations,
        author: AUTHOR_NAME,
        batchSize: OPERATION_BATCH_SIZE,
        generateRedlines: state.editMode === 'track',
        onProgress: progress => {
          setStatusBanner(
            refs,
            `Applying resume edits for ${formatJobDisplayName(job)} (${progress.completed}/${progress.totalOperations})...`,
            'info'
          );
        }
      });
    }

    job.recommendation = aiOutput.recommendation;
    job.coverLetterOperationCount = coverLetterOperations.length;
    job.resumeOperationCount = resumeOperations.length;
    job.operationCount = job.coverLetterOperationCount + job.resumeOperationCount;

    // Surface which specific edits did not land (engine error or target text not found),
    // labelled by document so the user can tell what was dropped.
    const labelFailures = (failures, label) => failures.map(text => `${label}: ${text}`);
    job.failedOperations = [
      ...labelFailures(coverLetterApply.failures, 'Cover letter'),
      ...labelFailures(resumeApply.failures, 'Resume')
    ];
    job.failedOperationCount = job.failedOperations.length;

    // A package that fails OOXML validation may be corrupt — never report it as clean.
    const validationErrors = [
      coverLetterApply.validation.ok ? null : `Cover letter: ${coverLetterApply.validation.error}`,
      resumeApply.validation.ok ? null : `Resume: ${resumeApply.validation.error}`
    ].filter(Boolean);
    job.validationError = validationErrors.join(' | ');

    job.status = (job.failedOperationCount > 0 || validationErrors.length > 0) ? 'partial' : 'done';

    await persistJobResult(job, coverLetterZip, resumeZip, {
      recommendation: aiOutput.recommendation,
      coverLetter: {
        operations: coverLetterOperations,
        operationResults: coverLetterApply.results,
        validation: coverLetterApply.validation
      },
      resume: {
        recommendation: resumeAiOutput?.recommendation || '',
        operations: resumeOperations,
        operationResults: resumeApply.results,
        validation: resumeApply.validation
      },
      failedOperations: job.failedOperations,
      validationError: job.validationError,
      mode: state.editMode
    });

    const statusLevel = job.status === 'partial' ? 'warn' : 'success';
    const partialNote = validationErrors.length > 0
      ? ` ${job.failedOperationCount} edit(s) not applied; output may be invalid.`
      : (job.failedOperationCount > 0 ? ` ${job.failedOperationCount} edit(s) could not be applied.` : '');
    setStatusBanner(
      refs,
      `${JOB_STATUS_LABELS[job.status]}: ${formatJobDisplayName(job)} (${job.coverLetterOperationCount} cover letter + ${job.resumeOperationCount} resume operations).${partialNote}`,
      statusLevel
    );
  } catch (error) {
    job.status = 'failed';
    job.runtime.error = error?.message || String(error);
    job.recommendation = `Generation failed: ${job.runtime.error}`;
    setStatusBanner(refs, `Failed ${formatJobDisplayName(job)}: ${job.runtime.error}`, 'error');
  }

  await persistSessionState();
  renderUi(refs);
  if (job.id === state.selectedJobId) {
    await renderSelectedPreview(refs);
  }
}

async function runSelectedJob(refs) {
  if (state.isRunning) return;
  const job = getSelectedJob();
  if (!job) {
    setStatusBanner(refs, 'Select a job first.', 'warn');
    return;
  }

  state.isRunning = true;
  renderUi(refs);
  try {
    if (job.status === 'done' || job.status === 'partial' || job.status === 'failed') {
      job.status = 'retry';
    }
    await runJob(job, refs);
  } finally {
    state.isRunning = false;
    renderUi(refs);
  }
}

async function runAllJobs(refs) {
  if (state.isRunning) return;
  if (state.jobs.length === 0) {
    setStatusBanner(refs, 'Add jobs before running batch generation.', 'warn');
    return;
  }

  state.isRunning = true;
  renderUi(refs);

  try {
    if (!getNextRunnableJob(state.jobs)) {
      for (const job of state.jobs) {
        if (job.status === 'done' || job.status === 'partial' || job.status === 'failed') {
          job.status = 'retry';
        }
      }
    }

    // Claim the next runnable job synchronously (no await before the status flip)
    // so concurrent workers never grab the same job.
    const claimNextJob = () => {
      const job = getNextRunnableJob(state.jobs);
      if (!job) return null;
      job.status = 'preparing';
      if (!state.selectedJobId) {
        state.selectedJobId = job.id;
      }
      return job;
    };

    const worker = async () => {
      let job = claimNextJob();
      while (job) {
        await runJob(job, refs);
        job = claimNextJob();
      }
    };

    const workerCount = Math.min(RUN_ALL_CONCURRENCY, state.jobs.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    setStatusBanner(refs, 'Batch generation complete.', 'success');
  } finally {
    state.isRunning = false;
    renderUi(refs);
    await renderSelectedPreview(refs);
  }
}

async function downloadSelectedJob(refs) {
  const selectedJob = getSelectedJob();
  if (!selectedJob) return;

  const coverLetterBlob = await state.store.getBlob(selectedJob.storage.resultKey);
  if (!coverLetterBlob) {
    setStatusBanner(refs, 'No generated file found for selected job yet.', 'warn');
    return;
  }

  const resumeBlob = await state.store.getBlob(selectedJob.storage.resumeResultKey);
  if (resumeBlob) {
    const archiveBlob = await createArchiveBlob([
      { name: buildOutputFileName(selectedJob), blob: coverLetterBlob },
      { name: buildResumeOutputFileName(selectedJob), blob: resumeBlob }
    ]);
    const bundleName = buildJobBundleName(selectedJob);
    downloadBlob(archiveBlob, bundleName);
    setStatusBanner(refs, `Exported ${bundleName}`, 'success');
    return;
  }

  const outputName = buildOutputFileName(selectedJob);
  downloadBlob(coverLetterBlob, outputName);
  setStatusBanner(refs, `Exported ${outputName}`, 'success');
}

async function downloadAllJobs(refs) {
  const fileGroups = await Promise.all(state.jobs.map(async job => {
    const coverLetterBlob = await state.store.getBlob(job.storage.resultKey);
    if (!coverLetterBlob) return [];

    const group = [{ name: buildOutputFileName(job), blob: coverLetterBlob }];
    const resumeBlob = await state.store.getBlob(job.storage.resumeResultKey);
    if (resumeBlob) {
      group.push({ name: buildResumeOutputFileName(job), blob: resumeBlob });
    }
    return group;
  }));
  const files = fileGroups.flat();

  if (files.length === 0) {
    setStatusBanner(refs, 'No generated letters to export yet.', 'warn');
    return;
  }

  const archiveBlob = await createArchiveBlob(files);
  downloadBlob(archiveBlob, 'cover-letters-batch.zip');
  setStatusBanner(refs, `Exported ${files.length} tailored file(s).`, 'success');
}

function wireDropZone(refs, dropZoneKey, fileInputKey, onFiles) {
  const dropZone = refs[dropZoneKey];
  const fileInput = refs[fileInputKey];

  const preventDefaults = event => {
    event.preventDefault();
    event.stopPropagation();
  };

  for (const eventName of ['dragenter', 'dragover']) {
    dropZone.addEventListener(eventName, event => {
      preventDefaults(event);
      setDropZoneActive(refs, dropZoneKey, true);
    });
  }

  for (const eventName of ['dragleave', 'dragend', 'drop']) {
    dropZone.addEventListener(eventName, event => {
      preventDefaults(event);
      setDropZoneActive(refs, dropZoneKey, false);
    });
  }

  dropZone.addEventListener('drop', async event => {
    const files = event.dataTransfer?.files;
    if (files?.length) {
      await onFiles(files);
    }
  });

  dropZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async event => {
    const files = event.target.files;
    if (files?.length) {
      await onFiles(files);
    }
    fileInput.value = '';
  });
}

async function init() {
  const refs = getUiRefs();
  state.store = await createDocumentStore();

  console.info(`[Application Station] App version ${APP_VERSION}`);

  populateModelSelect(refs);
  const storedPromptSettings = getStoredPromptSettings();
  state.promptSettings.model = normalizeGeminiModel(storedPromptSettings.model);
  refs.modelSelect.value = state.promptSettings.model;

  const prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches || false;
  state.theme = getStoredTheme() || (prefersDark ? 'dark' : 'light');
  applyTheme(refs, state.theme);

  state.editMode = getStoredEditMode();
  setModeButtons(refs, state.editMode);
  state.includeComments = getStoredIncludeComments();
  refs.includeCommentsToggle.checked = state.includeComments;
  state.onboarding.dismissed = getStoredOnboardingDismissed();
  state.onboarding.forcedOpen = false;

  refs.apiKeyInput.value = getStoredApiKey();
  refs.apiKeyInput.addEventListener('input', () => {
    refreshControls(refs);
    refreshOnboarding(refs);
  });

  closeAllActionMenus(refs);
  closeSettingsModal(refs);
  wireSidebarResizer(refs);

  refs.settingsBtn.addEventListener('click', () => {
    openSettingsModal(refs);
  });
  refs.onboardingBtn.addEventListener('click', () => {
    closeSettingsModal(refs);
    openOnboardingModal(refs, true);
  });
  refs.themeToggleBtn.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    setStoredTheme(state.theme);
    applyTheme(refs, state.theme);
  });
  refs.settingsCloseBtn.addEventListener('click', () => {
    closeSettingsModal(refs);
  });
  refs.settingsBackdrop.addEventListener('click', () => {
    closeSettingsModal(refs);
  });
  refs.onboardingBackdrop.addEventListener('click', () => {
    closeOnboardingModal(refs, { dismiss: true });
  });
  refs.onboardingCloseBtn.addEventListener('click', () => {
    closeOnboardingModal(refs, { dismiss: true });
  });
  refs.onboardingDismissBtn.addEventListener('click', () => {
    closeOnboardingModal(refs, { dismiss: true });
  });
  refs.onboardingPrimaryBtn.addEventListener('click', () => {
    handleOnboardingPrimaryAction(refs);
  });

  refs.runMenuBtn.addEventListener('click', event => {
    event.stopPropagation();
    toggleActionMenu(refs, 'run');
  });
  refs.downloadMenuBtn.addEventListener('click', event => {
    event.stopPropagation();
    toggleActionMenu(refs, 'download');
  });
  refs.runMenu.addEventListener('click', event => event.stopPropagation());
  refs.downloadMenu.addEventListener('click', event => event.stopPropagation());

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('.split-action')) {
      closeAllActionMenus(refs);
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeAllActionMenus(refs);
      closeSettingsModal(refs);
      closeOnboardingModal(refs, { dismiss: true });
    }
  });

  refs.saveApiKeyBtn.addEventListener('click', async () => {
    const apiKey = refs.apiKeyInput.value.trim();
    const fingerprint = getApiKeyFingerprint(apiKey);
    const validated = getStoredApiKeyValidation();
    if (!fingerprint || (validated.fingerprint && validated.fingerprint !== fingerprint)) {
      clearStoredApiKeyValidation();
    }
    setStoredApiKey(apiKey);
    setStatusBanner(
      refs,
      apiKey
        ? 'API key saved locally in this browser. Validating now...'
        : 'API key removed from local browser storage.',
      'success'
    );
    renderUi(refs);
    if (apiKey) {
      await validateApiKeyInput(refs);
    }
  });
  refs.modelSelect.addEventListener('change', () => {
    state.promptSettings.model = normalizeGeminiModel(refs.modelSelect.value);
    setStoredPromptSettings(state.promptSettings);
    setStatusBanner(refs, `Model set to ${refs.modelSelect.options[refs.modelSelect.selectedIndex]?.text || refs.modelSelect.value}.`, 'info');
  });

  refs.directModeBtn.addEventListener('click', () => {
    state.editMode = 'direct';
    setStoredEditMode(state.editMode);
    setModeButtons(refs, state.editMode);
    setStatusBanner(refs, 'Direct edit mode enabled.', 'info');
  });

  refs.trackModeBtn.addEventListener('click', () => {
    state.editMode = 'track';
    setStoredEditMode(state.editMode);
    setModeButtons(refs, state.editMode);
    setStatusBanner(refs, 'Track changes mode enabled.', 'info');
  });

  refs.includeCommentsToggle.addEventListener('change', () => {
    state.includeComments = refs.includeCommentsToggle.checked;
    setStoredIncludeComments(state.includeComments);
    setStatusBanner(
      refs,
      state.includeComments
        ? 'Reviewer comments will be included in generated documents.'
        : 'Reviewer comments will be omitted from generated documents.',
      'info'
    );
  });

  wireDropZone(refs, 'baseDropZone', 'baseFileInput', async files => {
    await setBaseFile(refs, files[0]);
  });

  wireDropZone(refs, 'resumeDropZone', 'resumeFileInput', async files => {
    await setResumeFile(refs, files[0]);
  });

  wireDropZone(refs, 'samplesDropZone', 'sampleFilesInput', async files => {
    await addSampleFiles(refs, files);
  });

  refs.addJobBtn.addEventListener('click', () => addSingleJobFromInputs(refs));
  refs.clearSamplesBtn.addEventListener('click', () => clearSampleLetters(refs));
  refs.clearApplicationsBtn.addEventListener('click', () => clearTailoredApplications(refs));
  refs.previewCoverLetterBtn.addEventListener('click', async () => {
    state.previewType = 'coverLetter';
    await persistSessionState();
    renderUi(refs);
    await renderSelectedPreview(refs);
  });
  refs.previewResumeBtn.addEventListener('click', async () => {
    if (refs.previewResumeBtn.disabled) return;
    state.previewType = 'resume';
    await persistSessionState();
    renderUi(refs);
    await renderSelectedPreview(refs);
  });
  refs.acceptAllChangesBtn.addEventListener('click', async () => {
    await acceptAllPreviewRedlines(refs);
  });

  refs.jobList.addEventListener('click', async event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const actionButton = target.closest('[data-job-action]');
    if (actionButton) {
      const action = actionButton.getAttribute('data-job-action');
      const actionJobId = actionButton.getAttribute('data-job-id');
      if (action === 'remove' && actionJobId) {
        await removeTailoredApplicationById(refs, actionJobId);
      }
      return;
    }

    const card = target.closest('[data-job-id]');
    if (!card) return;

    const jobId = card.getAttribute('data-job-id');
    if (!jobId) return;

    state.selectedJobId = jobId;
    await persistSessionState();
    renderUi(refs);
    await renderSelectedPreview(refs);
  });

  refs.runSelectedBtn.addEventListener('click', () => runSelectedJob(refs));
  refs.runAllBtn.addEventListener('click', async () => {
    closeAllActionMenus(refs);
    await runAllJobs(refs);
  });
  refs.downloadBtn.addEventListener('click', () => downloadSelectedJob(refs));
  refs.downloadAllBtn.addEventListener('click', async () => {
    closeAllActionMenus(refs);
    await downloadAllJobs(refs);
  });

  const restoredSession = await restoreSessionState();
  renderUi(refs);
  if (restoredSession.restored) {
    setStatusBanner(
      refs,
      `Restored previous session (${restoredSession.jobCount} job${restoredSession.jobCount === 1 ? '' : 's'}).`,
      'success'
    );
    await renderSelectedPreview(refs);
  } else {
    setStatusBanner(refs, 'Upload a base cover letter, then add one or more jobs.', 'info');
    await renderSelectedPreview(refs);
  }
}

if (typeof document !== 'undefined') {
  init();
}
