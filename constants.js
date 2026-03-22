export const APP_VERSION = '2026-03-18-cover-letter-v1';

export const JOB_STATUS_LABELS = {
  queued: 'Queued',
  preparing: 'Preparing',
  tailoring: 'Tailoring',
  applying: 'Applying',
  done: 'Done',
  partial: 'Partial',
  failed: 'Failed',
  retry: 'Retry'
};

export const STORAGE_KEYS = {
  GEMINI_API_KEY: 'coverLetterAi.geminiApiKey',
  PROMPT_SETTINGS: 'coverLetterAi.promptSettings',
  EDIT_MODE: 'coverLetterAi.editMode',
  API_KEY_VALIDATION: 'coverLetterAi.apiKeyValidation',
  ONBOARDING_DISMISSED: 'coverLetterAi.onboardingDismissed',
  SIDEBAR_WIDTH: 'coverLetterAi.sidebarWidth'
};

export const GEMINI_MODEL_OPTIONS = [
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' }
];

export const DEFAULT_GEMINI_MODEL = GEMINI_MODEL_OPTIONS[0].value;

export const ALLOWED_HIGHLIGHT_COLORS = ['yellow', 'green', 'cyan', 'magenta', 'blue', 'red'];

export const OPERATION_BATCH_SIZE = 3;
export const REDLINE_CAP = 12;
export const MAX_BASE_LETTER_CHARS = 24000;
export const MAX_CONTEXT_CHARS = 54000;
export const MAX_JOB_DESCRIPTION_CHARS = 24000;
