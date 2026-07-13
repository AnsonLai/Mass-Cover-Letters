/* ==========================================================================
   QUILL — the Application Station raven mascot.
   One SVG, many moods. Drop <div class="as-mascot" data-mood="hello"></div>
   anywhere and this script fills it in. Moods are pure CSS (styles.css,
   "QUILL MASCOT" section):
     hello | happy | thinking | writing | excited | cheer | soft
   Change mood at runtime with: el.dataset.mood = 'writing'
   ========================================================================== */

(function () {
  const QUILL_SVG = `
<svg viewBox="0 0 120 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="asRavenBodyG" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0" stop-color="#4A5266"/>
      <stop offset="1" stop-color="#2E3447"/>
    </linearGradient>
    <linearGradient id="asRavenQuillG" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#4FAE87"/>
      <stop offset="1" stop-color="#A8DCC4"/>
    </linearGradient>
  </defs>

  <ellipse class="m-shadow" cx="60" cy="119" rx="25" ry="5" fill="rgba(23,37,31,.14)"/>

  <g class="m-all">
    <!-- confetti (cheer mood) — each piece gets its own trajectory -->
    <g class="m-confetti">
      <rect x="18" y="16" width="5" height="7" rx="1.5" fill="#F4B860" style="--cx:-16px; --cy:-30px; --cr:260deg"/>
      <circle cx="60" cy="8" r="3" fill="#7BC7A6" style="--cx:2px; --cy:-26px; --cr:120deg"/>
      <rect x="96" y="14" width="5" height="7" rx="1.5" fill="#F29AA1" style="--cx:18px; --cy:-32px; --cr:-240deg"/>
      <circle cx="32" cy="6" r="2.6" fill="#B08AE8" style="--cx:-12px; --cy:-24px; --cr:180deg"/>
      <rect x="74" y="4" width="4.6" height="6.6" rx="1.5" fill="#4FAE87" style="--cx:12px; --cy:-28px; --cr:300deg"/>
      <circle cx="104" cy="28" r="2.4" fill="#F4B860" style="--cx:14px; --cy:-20px; --cr:-160deg"/>
    </g>

    <!-- sparkles (excited mood) -->
    <path class="m-spark" d="M20 34l1.6 4 4 1.6-4 1.6-1.6 4-1.6-4-4-1.6 4-1.6z" fill="#F4B860"/>
    <path class="m-spark" d="M98 26l1.4 3.4 3.4 1.4-3.4 1.4-1.4 3.4-1.4-3.4-3.4-1.4 3.4-1.4z" fill="#F4B860"/>

    <!-- quill pen (writing mood) -->
    <g class="m-quill">
      <path d="M95 80 C 98 66, 104 54, 114 44 C 112 58, 107 70, 99 80 Z" fill="url(#asRavenQuillG)"/>
      <path d="M97 79 C 101 66, 106 55, 113 46" stroke="#1E7A5B" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <path d="M95 80 L92 86" stroke="#175E47" stroke-width="2.4" stroke-linecap="round"/>
    </g>

    <!-- tail (behind body, lower-left) -->
    <path class="m-tail" d="M38 90 C 28 96, 18 103, 10 111 C 22 110, 33 106, 42 99 Z" fill="#262C3C"/>

    <!-- wings (behind body sides) -->
    <path class="m-wing m-wing-l" d="M29 58 C 17 55, 10 63, 17 71 C 23 77, 31 72, 32 64 Z" fill="#262C3C"/>
    <path class="m-wing m-wing-r" d="M91 58 C 103 55, 110 63, 103 71 C 97 77, 89 72, 88 64 Z" fill="#262C3C"/>

    <!-- feet -->
    <path class="m-foot" d="M47 100 L41 110 M49 101 L47 111 M51 101 L54 110" stroke="#EF9E3E" stroke-width="3.2" stroke-linecap="round" fill="none"/>
    <path class="m-foot" d="M73 100 L79 110 M71 101 L73 111 M69 101 L66 110" stroke="#EF9E3E" stroke-width="3.2" stroke-linecap="round" fill="none"/>

    <!-- head tufts -->
    <g class="m-tufts" fill="#262C3C">
      <path d="M55 24 C 52 16, 54 9, 60 4 C 59 12, 61 18, 65 23 Z"/>
      <path d="M46 27 C 41 21, 39 14, 42 8 C 46 14, 50 20, 53 25 Z"/>
      <path d="M69 23 C 72 16, 72 10, 69 5 C 76 10, 79 17, 77 24 Z"/>
    </g>

    <!-- body (head + body in one blob, widest at the top) -->
    <path class="m-body" d="M60 22 C 37 22, 25 39, 25 63 C 25 87, 39 102, 60 102 C 81 102, 95 87, 95 63 C 95 39, 83 22, 60 22 Z" fill="url(#asRavenBodyG)"/>
    <ellipse class="m-belly" cx="60" cy="85" rx="16" ry="11" fill="#5C6579" opacity=".4"/>
    <ellipse class="m-shine" cx="46" cy="33" rx="10" ry="4.5" fill="#FFFFFF" opacity=".13" transform="rotate(-18 46 33)"/>

    <!-- face -->
    <g class="m-face">
      <!-- exaggerated eyes -->
      <g class="m-eye m-eye-l">
        <circle cx="45.5" cy="54" r="11.5" fill="#FFFFFF" stroke="#232B3E" stroke-width="1.8"/>
        <g class="m-pupil">
          <circle cx="47" cy="56" r="6" fill="#232B3E"/>
          <circle cx="44.6" cy="53.4" r="2.3" fill="#FFFFFF"/>
          <circle cx="49.6" cy="58.2" r="1.1" fill="#FFFFFF" opacity=".85"/>
        </g>
      </g>
      <g class="m-eye m-eye-r">
        <circle cx="74.5" cy="54" r="11.5" fill="#FFFFFF" stroke="#232B3E" stroke-width="1.8"/>
        <g class="m-pupil">
          <circle cx="73" cy="56" r="6" fill="#232B3E"/>
          <circle cx="70.6" cy="53.4" r="2.3" fill="#FFFFFF"/>
          <circle cx="75.6" cy="58.2" r="1.1" fill="#FFFFFF" opacity=".85"/>
        </g>
      </g>

      <!-- happy closed eyes (cheer) -->
      <path class="m-lid m-lid-l" d="M36 55 Q45.5 46 55 55" stroke="#232B3E" stroke-width="2.8" fill="none" stroke-linecap="round"/>
      <path class="m-lid m-lid-r" d="M65 55 Q74.5 46 84 55" stroke="#232B3E" stroke-width="2.8" fill="none" stroke-linecap="round"/>

      <!-- brows (thinking / soft) -->
      <path class="m-brow m-brow-l" d="M38 39.5 Q45.5 36 53 39.5" stroke="#232B3E" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <path class="m-brow m-brow-r" d="M67 39.5 Q74.5 36 82 39.5" stroke="#232B3E" stroke-width="2.4" fill="none" stroke-linecap="round"/>

      <!-- blush -->
      <ellipse class="m-blush" cx="33" cy="65" rx="5.5" ry="3.4" fill="#F58FA0" opacity=".55"/>
      <ellipse class="m-blush" cx="87" cy="65" rx="5.5" ry="3.4" fill="#F58FA0" opacity=".55"/>

      <!-- beak, closed (default: friendly) -->
      <g class="m-beak-closed">
        <path d="M50 62 Q60 55 70 62 Q60 69 50 62 Z" fill="#F6AC42"/>
        <path d="M54 66 Q60 70.5 66 66" stroke="#E8933C" stroke-width="2" fill="none" stroke-linecap="round"/>
      </g>

      <!-- beak, open (excited / cheer) -->
      <g class="m-beak-open">
        <path d="M52 61 Q60 74 68 61 Q60 66 52 61 Z" fill="#6B3115"/>
        <path d="M50 60 Q60 53 70 60 Q60 64 50 60 Z" fill="#F6AC42"/>
        <path d="M54 69 Q60 74.5 66 69 Q60 71.5 54 69 Z" fill="#FFC26E"/>
      </g>
    </g>
  </g>
</svg>`;

  let uid = 0;
  function mount(root) {
    (root || document).querySelectorAll('.as-mascot').forEach(function (el) {
      if (!el.dataset.mounted) {
        // Unique gradient ids per instance — a shared id breaks when the first
        // SVG holding the <defs> sits inside a display:none container.
        uid += 1;
        el.innerHTML = QUILL_SVG
          .split('asRavenBodyG').join('asRavenBodyG' + uid)
          .split('asRavenQuillG').join('asRavenQuillG' + uid);
        if (!el.dataset.mood) el.dataset.mood = 'happy';
        el.dataset.mounted = '1';
      }
    });
  }

  window.asMountMascots = mount;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount(); });
  } else {
    mount();
  }
})();
