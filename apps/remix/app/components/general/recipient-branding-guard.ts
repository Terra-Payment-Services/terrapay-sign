import { BRANDING_CONTRAST_THRESHOLD } from '@documenso/lib/utils/branding-contrast';

import {
  collectTargets,
  createContrastReader,
  findColourAnimations,
  type MeasureTarget,
  paintsNoBoundary,
} from './recipient-branding-measure';
import { applyPrintRules, findMediaQueries } from './recipient-branding-media';

/** The colour-token style elements `recipient-branding.tsx` renders, by SSR and by effect. */
export const TOKEN_STYLE_SELECTOR = 'style[data-branding-tokens]';

const findTokenStyles = () => [...document.querySelectorAll<HTMLStyleElement>(TOKEN_STYLE_SELECTOR)];

/**
 * How much worse than the default theme a text element may read before the guard blames the tenant
 * branding. Control boundaries get no margin (round 22). The default theme has low-contrast elements of its own, such as placeholders and
 * muted icons at about 1.7:1 to 2.3:1, and the guard does not disable a stylesheet over those.
 * The margin matches `BASELINE_MARGIN` in the round 11 tests.
 */
const BASELINE_MARGIN = 0.3;

/** Stops colour transitions while the guard switches the stylesheet off and on to read the baseline. */
const FREEZE_CSS = '*, *::before, *::after, *::placeholder { transition: none !important; }';

/** True when the target or one of its ancestors is in a colour transition or animation. */
const findUnsettled = (target: MeasureTarget, animating: Map<Element, Animation[]>): Animation[] | null => {
  for (let node: Element | null = target.element; node; node = node.parentElement) {
    const animations = animating.get(node);

    if (animations) {
      return animations;
    }
  }

  return null;
};

/**
 * Applies the tenant stylesheet in `style` and keeps it, and the tenant colour tokens, only while
 * everything the signer reads is at least 3:1 or no worse than the default theme makes it: within
 * `BASELINE_MARGIN` for text, and at or above the default theme's ratio for a control boundary, with
 * controls that draw no boundary in the default theme excluded. Elements below 3:1 are measured
 * again in the default theme, with the stylesheet and the token style elements switched off (the
 * logo is not touched), in the same task and with transitions frozen, so the switch never paints.
 * On a failure the stylesheet is disabled and the page measured again; if anything still fails,
 * the token style elements are disabled too (round 22). Each stays off for the visit. A tenant selector names no state (round 14), but the app's
 * own hover, active and focus-visible styles outrank tenant rules and can pair an app colour with a
 * tenant one, so the whole page is measured, once per frame, when the DOM changes, hover or focus
 * starts or ends anywhere, a pointer button or key goes down or up, the signer types, or a
 * transition ends; an element in a colour or opacity transition or animation, or inside one, is
 * measured once it settles. It is measured
 * synchronously when one of its media conditions, print media or the colour scheme changes, on
 * resize, and before printing; and when a token style element changes. A disabled stylesheet carries
 * `data-branding-guard="contrast"` and each disabled token style element `data-branding-guard="tokens"`.
 * The guard also runs when there are tokens and no stylesheet.
 *
 * @param style the tenant stylesheet element, appended with `media="not all"` so it never paints
 *   before it is first measured, or null when the tenant has no stylesheet
 * @returns a cleanup that stops watching
 */
export const guardBranding = (style: HTMLStyleElement | null): (() => void) => {
  let isSheetOff = !style;
  let isTokensOff = false;
  let isDone = false;
  let isScheduled = false;
  let needsAll = false;
  const pending = new Set<Element>();

  // A copy of the stylesheet with its print rules applied, present only while `beforeprint` measures.
  let printCopy: HTMLStyleElement | null = null;

  // The guard's own style elements, whose insertion and removal must not schedule a measurement.
  const ownSheets = new WeakSet<Node>();

  /** Stops guarding once nothing tenant-supplied is left on the page. */
  const finishIfBare = () => {
    if (isSheetOff && (isTokensOff || findTokenStyles().length === 0)) {
      isDone = true;
      stop();
    }
  };

  /** Disables the stylesheet for the visit, recording why on the element. */
  const disableSheet = () => {
    isSheetOff = true;

    if (style) {
      style.disabled = true;
      style.setAttribute('data-branding-guard', 'contrast');
    }

    // The print copy is the stylesheet too, so the scan that follows sees only the tokens (round 23).
    if (printCopy) {
      printCopy.disabled = true;
    }

    finishIfBare();
  };

  /** Disables every token style element for the visit, recording why on each. */
  const disableTokens = () => {
    isTokensOff = true;

    for (const tokens of findTokenStyles()) {
      tokens.disabled = true;
      tokens.setAttribute('data-branding-guard', 'tokens');
    }

    finishIfBare();
  };

  /** A style element carrying the page's CSP nonce. */
  const addSheet = (css: string) => {
    const sheet = document.createElement('style');

    sheet.setAttribute('nonce', style?.nonce || findTokenStyles()[0]?.nonce || '');
    sheet.textContent = css;
    ownSheets.add(sheet);
    document.head.appendChild(sheet);

    return sheet;
  };

  /**
   * Each target in the default theme, with the tenant stylesheet and tokens switched off, read
   * without painting: its ratio, and for a boundary whether it draws none there.
   */
  const readBaseline = (targets: MeasureTarget[]): { ratio: number; isBare: boolean }[] => {
    const freeze = addSheet(FREEZE_CSS);
    const tokenStyles = findTokenStyles();

    if (style) {
      style.disabled = true;
    }

    if (printCopy) {
      printCopy.disabled = true;
    }

    for (const tokens of tokenStyles) {
      tokens.disabled = true;
    }

    try {
      const read = createContrastReader();

      return targets.map((target) => ({
        ratio: read(target),
        isBare: target.kind === 'boundary' && paintsNoBoundary(target.element),
      }));
    } finally {
      if (style) {
        style.disabled = isSheetOff;
      }

      // Restore only what the guard has not disabled.
      if (printCopy) {
        printCopy.disabled = isSheetOff;
      }

      for (const tokens of tokenStyles) {
        tokens.disabled = isTokensOff;
      }

      // Reading the same styles again, still frozen, settles every element the baseline touched
      // back on the tenant colours, so no transition starts when the freeze is lifted.
      targets.forEach(createContrastReader());
      freeze.remove();
    }
  };

  /** Reads `roots` and reports the targets it read and whether any fails against the default theme. */
  const scan = (roots: Iterable<Element>): { measured: MeasureTarget[]; isFailing: boolean } => {
    const read = createContrastReader();
    const measured: MeasureTarget[] = [];
    const low: { target: MeasureTarget; ratio: number }[] = [];

    const animating = findColourAnimations();

    for (const root of roots) {
      if (!root.isConnected) {
        continue;
      }

      for (const target of collectTargets(root)) {
        const unsettled = findUnsettled(target, animating);

        if (unsettled) {
          void Promise.allSettled(unsettled.map(async (animation) => animation.finished)).then(() =>
            measureSoon([target.element]),
          );

          continue;
        }

        const ratio = read(target);

        measured.push(target);

        if (ratio < BRANDING_CONTRAST_THRESHOLD) {
          low.push({ target, ratio });
        }
      }
    }

    if (low.length === 0) {
      return { measured, isFailing: false };
    }

    const baseline = readBaseline(low.map((item) => item.target));

    const isFailing = low.some(({ target, ratio }, index) => {
      const base = baseline[index];

      if (target.kind === 'boundary') {
        return !base.isBare && ratio < base.ratio;
      }

      return ratio < base.ratio - BASELINE_MARGIN;
    });

    return { measured, isFailing };
  };

  /**
   * Measures `roots`. On a failure, disables the stylesheet and measures the page again; if anything
   * still fails, disables the tokens too. Returns the targets read last.
   */
  const measure = (roots: Iterable<Element>): MeasureTarget[] => {
    if (isDone) {
      return [];
    }

    const first = scan(roots);

    if (!first.isFailing) {
      return first.measured;
    }

    if (!isSheetOff) {
      disableSheet();

      if (isDone) {
        return first.measured;
      }

      const again = scan([document.body]);

      if (!again.isFailing) {
        return again.measured;
      }
    }

    disableTokens();

    return first.measured;
  };

  /** A whole-page scan. */
  const measureAll = (): MeasureTarget[] => measure([document.body]);

  /**
   * Before printing, measures the screen state and then the print rules, applied through a copy of
   * the stylesheet with transitions frozen, since `beforeprint` runs before print media match.
   */
  const measureForPrint = () => {
    measureAll();

    if (isDone || isSheetOff || !style) {
      return;
    }

    const freeze = addSheet(FREEZE_CSS);

    printCopy = addSheet(style.textContent ?? '');
    applyPrintRules(printCopy.sheet?.cssRules);

    try {
      const measured = measureAll();

      printCopy.remove();
      measured.forEach(createContrastReader());
    } finally {
      printCopy.remove();
      printCopy = null;
      freeze.remove();
    }
  };

  /** Measures `roots` on the next frame, or the whole page when none are named. */
  const measureSoon = (roots?: Iterable<Element>) => {
    if (isDone) {
      return;
    }

    if (roots) {
      for (const root of roots) {
        pending.add(root);
      }
    } else {
      needsAll = true;
    }

    if (isScheduled) {
      return;
    }

    isScheduled = true;

    requestAnimationFrame(() => {
      const batch = needsAll ? null : [...pending];

      isScheduled = false;
      needsAll = false;
      pending.clear();

      if (batch) {
        measure(batch);
      } else {
        measureAll();
      }
    });
  };

  // Each event re-measures the whole page, once per frame: the app's state styles (`hover:`,
  // `active:`, `focus-visible:`, as in `packages/ui/primitives/button.tsx`) change one control's
  // colours under tenant rules that stay the same.
  const onInteraction = () => measureSoon();

  const observer = new MutationObserver(() => measureSoon());

  // The head holds the token style elements and any style a script adds; the guard's own freeze
  // and print sheets are left out, or each measurement would schedule the next.
  const isOwn = (record: MutationRecord) =>
    ownSheets.has(record.target) ||
    (record.type === 'childList' &&
      [...record.addedNodes, ...record.removedNodes].every((node) => ownSheets.has(node)));

  const headObserver = new MutationObserver((records) => {
    if (records.some((record) => !isOwn(record))) {
      measureSoon();
    }
  });

  const INTERACTIONS = [
    'pointerover',
    'pointerout',
    'pointerdown',
    'pointerup',
    'focusin',
    'focusout',
    'keydown',
    'keyup',
    'input',
    'transitionend',
  ];

  // Media changes re-measure synchronously, in the same frame as the change: the stylesheet's own
  // conditions, print and colour scheme always, and resizes for width conditions and layout.
  const mediaQueries = [...findMediaQueries(style?.sheet?.cssRules), 'print', '(prefers-color-scheme: dark)'];
  const mediaLists = [...new Set(mediaQueries)].map((query) => window.matchMedia(query));
  const onMediaChange = () => measureAll();

  const stop = () => {
    observer.disconnect();
    headObserver.disconnect();
    window.removeEventListener('resize', onMediaChange);
    window.removeEventListener('beforeprint', measureForPrint);

    for (const list of mediaLists) {
      list.removeEventListener('change', onMediaChange);
    }

    for (const name of INTERACTIONS) {
      document.removeEventListener(name, onInteraction, true);
    }
  };

  if (!style && findTokenStyles().length === 0) {
    return stop;
  }

  // Apply and measure in one task, so an unreadable stylesheet is not painted on load.
  style?.removeAttribute('media');
  measureAll();

  if (isDone) {
    return stop;
  }

  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });

  for (const name of INTERACTIONS) {
    document.addEventListener(name, onInteraction, true);
  }

  for (const list of mediaLists) {
    list.addEventListener('change', onMediaChange);
  }

  window.addEventListener('resize', onMediaChange);
  window.addEventListener('beforeprint', measureForPrint);

  return stop;
};
