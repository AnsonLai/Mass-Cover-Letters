import { JOB_STATUS_LABELS } from './constants.js';

let toastHideTimer = null;

function getById(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element: #${id}`);
  return node;
}

export function getStatusLabel(status) {
  const value = String(status || '').trim().toLowerCase();
  if (!value) return 'Unknown';
  return JOB_STATUS_LABELS[value] || value[0].toUpperCase() + value.slice(1);
}

export function formatJobDisplayName(job) {
  const company = String(job?.company || '').trim();
  const role = String(job?.role || '').trim();

  if (company && role) return `${company} - ${role}`;
  return company || role || 'Untitled Job';
}

export function getUiRefs() {
  return {
    onboardingBtn: getById('onboardingBtn'),
    themeToggleBtn: getById('themeToggleBtn'),
    settingsBtn: getById('settingsBtn'),
    settingsModal: getById('settingsModal'),
    settingsBackdrop: getById('settingsBackdrop'),
    settingsCloseBtn: getById('settingsCloseBtn'),
    apiKeyInput: getById('apiKeyInput'),
    saveApiKeyBtn: getById('saveApiKeyBtn'),
    modelSelect: getById('modelSelect'),
    directModeBtn: getById('directModeBtn'),
    trackModeBtn: getById('trackModeBtn'),
    includeCommentsToggle: getById('includeCommentsToggle'),
    runSelectedBtn: getById('runSelectedBtn'),
    runMenuBtn: getById('runMenuBtn'),
    runMenu: getById('runMenu'),
    runAllBtn: getById('runAllBtn'),
    workspace: getById('workspace'),
    sidebar: getById('sidebar'),
    sidebarResizeHandle: getById('sidebarResizeHandle'),
    downloadBtn: getById('downloadBtn'),
    downloadMenuBtn: getById('downloadMenuBtn'),
    downloadMenu: getById('downloadMenu'),
    downloadAllBtn: getById('downloadAllBtn'),
    sourcePanel: getById('sourcePanel'),
    baseDropZone: getById('baseDropZone'),
    baseFileInput: getById('baseFileInput'),
    baseFileMeta: getById('baseFileMeta'),
    resumeDropZone: getById('resumeDropZone'),
    resumeFileInput: getById('resumeFileInput'),
    resumeFileMeta: getById('resumeFileMeta'),
    samplesDropZone: getById('samplesDropZone'),
    sampleFilesInput: getById('sampleFilesInput'),
    samplesFileMeta: getById('samplesFileMeta'),
    clearSamplesBtn: getById('clearSamplesBtn'),
    jobInputPanel: getById('jobInputPanel'),
    jobCompanyInput: getById('jobCompanyInput'),
    jobRoleInput: getById('jobRoleInput'),
    jobDescriptionInput: getById('jobDescriptionInput'),
    addJobBtn: getById('addJobBtn'),
    queueMeta: getById('queueMeta'),
    jobList: getById('jobList'),
    clearApplicationsBtn: getById('clearApplicationsBtn'),
    statusBanner: getById('statusBanner'),
    selectedJobTitle: getById('selectedJobTitle'),
    selectedJobMeta: getById('selectedJobMeta'),
    recommendationCard: getById('recommendationCard'),
    recommendationText: getById('recommendationText'),
    previewTitle: getById('previewTitle'),
    previewCoverLetterBtn: getById('previewCoverLetterBtn'),
    previewResumeBtn: getById('previewResumeBtn'),
    acceptAllChangesBtn: getById('acceptAllChangesBtn'),
    previewStatus: getById('previewStatus'),
    previewHost: getById('previewHost'),
    onboardingModal: getById('onboardingModal'),
    onboardingBackdrop: getById('onboardingBackdrop'),
    onboardingCloseBtn: getById('onboardingCloseBtn'),
    onboardingDismissBtn: getById('onboardingDismissBtn'),
    onboardingPrimaryBtn: getById('onboardingPrimaryBtn'),
    onboardingHint: getById('onboardingHint'),
    onboardingStepApi: getById('onboardingStepApi'),
    onboardingStepApiStatus: getById('onboardingStepApiStatus'),
    onboardingStepDocs: getById('onboardingStepDocs'),
    onboardingStepDocsStatus: getById('onboardingStepDocsStatus'),
    onboardingStepJob: getById('onboardingStepJob'),
    onboardingStepJobStatus: getById('onboardingStepJobStatus'),
    onboardingStepGenerate: getById('onboardingStepGenerate'),
    onboardingStepGenerateStatus: getById('onboardingStepGenerateStatus'),
    toastHost: getById('toastHost')
  };
}

export function setDropZoneActive(refs, key, active) {
  refs[key].classList.toggle('active', Boolean(active));
}

export function setStatusBanner(refs, message, level = 'info') {
  refs.statusBanner.textContent = String(message || '');
  refs.statusBanner.dataset.level = level;
  refs.statusBanner.hidden = true;

  const durationByLevel = {
    info: 1800,
    success: 2600,
    warn: 3600,
    error: 5000
  };
  showToast(refs, message, level, durationByLevel[level] ?? 2600);
}

export function setPreviewStatus(refs, message, level = 'info') {
  refs.previewStatus.textContent = String(message || '');
  refs.previewStatus.dataset.level = level;
}

export function showToast(refs, message, level = 'info', durationMs = 3200) {
  const host = refs?.toastHost;
  if (!host) return;

  host.textContent = String(message || '');
  host.dataset.level = level;
  host.classList.add('visible');

  if (toastHideTimer) {
    clearTimeout(toastHideTimer);
    toastHideTimer = null;
  }

  const timeout = Number(durationMs);
  if (!Number.isFinite(timeout) || timeout <= 0) return;

  toastHideTimer = setTimeout(() => {
    host.classList.remove('visible');
    toastHideTimer = null;
  }, timeout);
}

export function setModeButtons(refs, mode) {
  const isTrack = mode === 'track';
  refs.directModeBtn.classList.toggle('active', !isTrack);
  refs.trackModeBtn.classList.toggle('active', isTrack);
}

export function setPreviewTypeButtons(refs, previewType) {
  const isResume = previewType === 'resume';
  refs.previewCoverLetterBtn.classList.toggle('active', !isResume);
  refs.previewResumeBtn.classList.toggle('active', isResume);
  refs.previewTitle.textContent = isResume ? 'Resume Preview' : 'Cover Letter Preview';
}

export function renderJobList(refs, jobs, selectedJobId) {
  const rows = Array.isArray(jobs) ? jobs : [];
  refs.jobList.replaceChildren();
  refs.queueMeta.textContent = `${rows.length} job${rows.length === 1 ? '' : 's'}`;

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'job-list-empty';
    empty.textContent = 'No jobs yet — add a job description to get started.';
    refs.jobList.appendChild(empty);
    return;
  }

  for (const job of rows) {
    const card = document.createElement('div');
    card.className = 'job-item';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'job-item-main';
    main.dataset.jobId = job.id;

    const title = document.createElement('p');
    title.className = 'job-item-title';
    title.textContent = String(job.company || 'Company');
    main.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'job-item-sub';
    sub.textContent = String(job.role || 'Role');
    main.appendChild(sub);

    const status = document.createElement('p');
    const normalizedStatus = String(job.status || 'queued').trim().toLowerCase();
    const isCompletedLike = normalizedStatus === 'done' || normalizedStatus === 'partial';
    const statusClass = isCompletedLike ? 'done' : normalizedStatus;
    if (isCompletedLike) card.classList.add('is-complete');
    if (job.id === selectedJobId) card.classList.add('active');
    status.className = `job-item-status ${statusClass}`;
    status.textContent = isCompletedLike ? 'Completed' : getStatusLabel(normalizedStatus);
    main.appendChild(status);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'job-item-remove';
    removeBtn.dataset.jobAction = 'remove';
    removeBtn.dataset.jobId = job.id;
    removeBtn.setAttribute('aria-label', `Remove ${formatJobDisplayName(job)}`);
    removeBtn.title = 'Remove';
    removeBtn.textContent = '\u00d7';

    card.appendChild(main);
    card.appendChild(removeBtn);
    refs.jobList.appendChild(card);
  }
}

export function setActionEnabled(refs, key, enabled) {
  refs[key].disabled = !enabled;
}

export function renderSelectedJob(refs, job) {
  if (!job) {
    refs.selectedJobTitle.textContent = 'No Job Selected';
    refs.selectedJobMeta.textContent = 'Add a job description to begin tailoring.';
    refs.recommendationCard.hidden = true;
    refs.recommendationText.textContent = '';
    return;
  }

  const failedCount = Number(job.failedOperationCount || 0);

  refs.selectedJobTitle.textContent = formatJobDisplayName(job);
  refs.selectedJobMeta.textContent = [
    `${job.operationCount || 0} total operation${job.operationCount === 1 ? '' : 's'}`,
    `${job.coverLetterOperationCount || 0} cover letter`,
    `${job.resumeOperationCount || 0} resume`,
    failedCount > 0 ? `${failedCount} not applied` : ''
  ].filter(Boolean).join(' • ');

  const recommendation = String(job.recommendation || '').trim();
  const failures = Array.isArray(job.failedOperations) ? job.failedOperations.filter(Boolean) : [];
  const validationError = String(job.validationError || '').trim();

  const lines = [];
  if (recommendation) lines.push(recommendation);
  if (failures.length > 0) {
    lines.push(`⚠ ${failures.length} edit${failures.length === 1 ? '' : 's'} not applied:\n- ${failures.join('\n- ')}`);
  }
  if (validationError) {
    lines.push(`⚠ Validation warning: ${validationError}`);
  }

  // Preserve the line breaks used above regardless of stylesheet defaults.
  refs.recommendationText.style.whiteSpace = 'pre-wrap';
  refs.recommendationCard.hidden = lines.length === 0;
  refs.recommendationText.textContent = lines.join('\n\n');
}
