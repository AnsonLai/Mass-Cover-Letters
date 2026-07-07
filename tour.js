const MARGIN = 12;
const SPOTLIGHT_PAD = 8;

let activeTour = null;

const TOUR_STEPS = [
  {
    ref: 'sourcePanel',
    title: 'Start with your best letter',
    body: 'Everything begins here. Upload your strongest cover letter as the **base** — the AI tailors this letter for every job. Adding your resume and one or two sample letters is optional but helps the AI use your real stories and match your voice.',
    preferred: 'right'
  },
  {
    ref: 'jobInputPanel',
    title: 'Add a job',
    body: 'Paste a job description here. Company and role are optional — the AI infers them from the posting. Add as many jobs as you like; each becomes its own tailored application.',
    preferred: 'right'
  },
  {
    ref: 'jobList',
    title: 'Your application queue',
    body: 'Every job you add lands here. Click one to select it; its tailored letter shows in the preview. The colored status tells you where each job is: Queued, Tailoring, or Completed.',
    preferred: 'right'
  },
  {
    ref: 'runSelectedBtn',
    target(refs) {
      return refs.runSelectedBtn?.closest?.('.split-action') || refs.runSelectedBtn;
    },
    title: 'Generate',
    body: 'This tailors the selected job — or use the little arrow for **Generate All** to process the whole queue. Each run costs one or two Gemini API calls.',
    preferred: 'bottom'
  },
  {
    ref: 'previewHost',
    target(refs) {
      return refs.previewHost?.closest?.('.preview-card') || refs.previewHost;
    },
    title: 'Review as tracked changes',
    body: 'Tailored edits appear as Word-style tracked changes — see exactly what changed and why. Happy with it? **Accept All Changes**. Prefer clean output with no markup? Switch to Direct Edits in Settings.',
    preferred: 'left'
  },
  {
    ref: 'downloadBtn',
    target(refs) {
      return refs.downloadBtn?.closest?.('.split-action') || refs.downloadBtn;
    },
    title: 'Export',
    body: 'Download the selected application as a ready-to-send .docx (plus tailored resume if you uploaded one), or **Export All** for a ZIP of everything.',
    preferred: 'bottom'
  },
  {
    ref: 'settingsBtn',
    title: 'Settings & your API key',
    body: 'One-time setup lives here: paste your free Gemini API key (the ? link shows how to get one), pick a model, and choose Track Changes or Direct Edits. Replay this tour anytime from Settings.',
    preferred: 'bottom'
  }
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fits(rect, viewport) {
  return rect.left >= MARGIN
    && rect.top >= MARGIN
    && rect.left + rect.width <= viewport.width - MARGIN
    && rect.top + rect.height <= viewport.height - MARGIN;
}

function placementForSide(targetRect, popoverSize, side) {
  const centeredLeft = targetRect.left + (targetRect.width - popoverSize.width) / 2;
  const centeredTop = targetRect.top + (targetRect.height - popoverSize.height) / 2;
  if (side === 'right') return { left: targetRect.right + MARGIN, top: centeredTop, width: popoverSize.width, height: popoverSize.height, side };
  if (side === 'left') return { left: targetRect.left - popoverSize.width - MARGIN, top: centeredTop, width: popoverSize.width, height: popoverSize.height, side };
  if (side === 'top') return { left: centeredLeft, top: targetRect.top - popoverSize.height - MARGIN, width: popoverSize.width, height: popoverSize.height, side };
  return { left: centeredLeft, top: targetRect.bottom + MARGIN, width: popoverSize.width, height: popoverSize.height, side: 'bottom' };
}

function oppositeSide(side) {
  return { right: 'left', left: 'right', top: 'bottom', bottom: 'top' }[side] || 'top';
}

export function computePopoverPlacement(targetRect, popoverSize, viewport, preferred = 'right') {
  const target = {
    left: Number(targetRect.left || 0),
    top: Number(targetRect.top || 0),
    right: Number(targetRect.right ?? (targetRect.left + targetRect.width)),
    bottom: Number(targetRect.bottom ?? (targetRect.top + targetRect.height)),
    width: Number(targetRect.width || 0),
    height: Number(targetRect.height || 0)
  };
  const size = {
    width: Math.min(Number(popoverSize.width || 0), Math.max(0, Number(viewport.width || 0) - MARGIN * 2)),
    height: Math.min(Number(popoverSize.height || 0), Math.max(0, Number(viewport.height || 0) - MARGIN * 2))
  };
  const vp = { width: Number(viewport.width || 0), height: Number(viewport.height || 0) };

  const primary = placementForSide(target, size, preferred);
  if (fits(primary, vp)) return { left: Math.round(primary.left), top: Math.round(primary.top), side: primary.side };

  const opposite = placementForSide(target, size, oppositeSide(preferred));
  if (fits(opposite, vp)) return { left: Math.round(opposite.left), top: Math.round(opposite.top), side: opposite.side };

  return {
    left: Math.round(clamp(target.left + (target.width - size.width) / 2, MARGIN, Math.max(MARGIN, vp.width - size.width - MARGIN))),
    top: Math.round(clamp(target.bottom + MARGIN, MARGIN, Math.max(MARGIN, vp.height - size.height - MARGIN))),
    side: 'clamped'
  };
}

export function isTourActive() {
  return Boolean(activeTour);
}

function renderMarkdownish(text) {
  return String(text || '').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}

export function startGuidedTour({ refs, onDone } = {}) {
  if (activeTour) activeTour.finish('skipped');
  if (typeof document === 'undefined') return;

  let index = 0;
  let raf = 0;
  const overlay = document.createElement('div');
  const spotlight = document.createElement('div');
  const popover = document.createElement('div');
  overlay.className = 'tour-overlay';
  spotlight.className = 'tour-spotlight';
  popover.className = 'tour-popover';
  popover.tabIndex = -1;
  popover.setAttribute('role', 'dialog');
  document.body.append(overlay, spotlight, popover);

  const getTarget = step => (typeof step.target === 'function' ? step.target(refs) : refs?.[step.ref]) || document.body;

  const updatePosition = () => {
    const target = getTarget(TOUR_STEPS[index]);
    const rect = target.getBoundingClientRect();
    const spot = {
      left: Math.max(0, rect.left - SPOTLIGHT_PAD),
      top: Math.max(0, rect.top - SPOTLIGHT_PAD),
      width: Math.min(window.innerWidth, rect.width + SPOTLIGHT_PAD * 2),
      height: Math.min(window.innerHeight, rect.height + SPOTLIGHT_PAD * 2)
    };
    Object.assign(spotlight.style, {
      left: `${spot.left}px`,
      top: `${spot.top}px`,
      width: `${spot.width}px`,
      height: `${spot.height}px`
    });
    const popRect = popover.getBoundingClientRect();
    const placement = computePopoverPlacement(rect, popRect, { width: window.innerWidth, height: window.innerHeight }, TOUR_STEPS[index].preferred);
    popover.style.left = `${placement.left}px`;
    popover.style.top = `${placement.top}px`;
  };

  const schedulePosition = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      updatePosition();
    });
  };

  const finish = status => {
    if (!activeTour) return;
    window.removeEventListener('resize', schedulePosition);
    window.removeEventListener('scroll', schedulePosition, true);
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    spotlight.remove();
    popover.remove();
    activeTour = null;
    onDone?.({ status, step: index });
  };

  const showStep = nextIndex => {
    index = clamp(nextIndex, 0, TOUR_STEPS.length - 1);
    const step = TOUR_STEPS[index];
    popover.setAttribute('aria-labelledby', `tourTitle${index}`);
    popover.innerHTML = `
      <span class="tour-step-label">Step ${index + 1} of ${TOUR_STEPS.length}</span>
      <h3 id="tourTitle${index}">${step.title}</h3>
      <p>${renderMarkdownish(step.body)}</p>
      <div class="tour-actions">
        <button type="button" class="secondary-btn" data-tour-action="back" ${index === 0 ? 'hidden' : ''}>Back</button>
        <button type="button" class="welcome-primary" data-tour-action="next">${index === TOUR_STEPS.length - 1 ? 'Finish' : 'Next'}</button>
        <button type="button" class="welcome-skip" data-tour-action="skip">Skip tour</button>
      </div>`;
    popover.querySelector('[data-tour-action="back"]')?.addEventListener('click', () => showStep(index - 1));
    popover.querySelector('[data-tour-action="next"]')?.addEventListener('click', () => {
      if (index === TOUR_STEPS.length - 1) finish('completed');
      else showStep(index + 1);
    });
    popover.querySelector('[data-tour-action="skip"]')?.addEventListener('click', () => finish('skipped'));
    getTarget(step).scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'smooth' });
    schedulePosition();
    setTimeout(updatePosition, 260);
    popover.focus();
  };

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish('skipped');
    } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
      event.preventDefault();
      if (index === TOUR_STEPS.length - 1) finish('completed');
      else showStep(index + 1);
    } else if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      showStep(index - 1);
    } else if (event.key === 'Tab') {
      const focusables = [...popover.querySelectorAll('button:not([hidden])')];
      if (focusables.length === 0) return;
      const current = document.activeElement;
      let next = focusables.indexOf(current);
      next = event.shiftKey ? next - 1 : next + 1;
      if (next < 0) next = focusables.length - 1;
      if (next >= focusables.length) next = 0;
      event.preventDefault();
      focusables[next].focus();
    }
  }

  activeTour = { finish };
  window.addEventListener('resize', schedulePosition);
  window.addEventListener('scroll', schedulePosition, true);
  document.addEventListener('keydown', onKeyDown, true);
  showStep(0);
}
