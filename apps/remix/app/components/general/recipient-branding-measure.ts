import { contrastRatio, parseCssColour, type Rgba } from '@documenso/lib/utils/parse-css-colour';

/**
 * What the signing-page guard reads (round 11): every visible element with its own text, the
 * text and placeholder of every text input and textarea, and the SVG fill and stroke of icons
 * inside buttons, links and tabs. The visibility rules follow `measureText` in
 * `packages/app-tests/e2e/branding-contrast-round11.spec.ts`. Since round 20 it also reads the
 * boundary of each control that shows no text, value, placeholder or icon (`boundary`).
 */
export type MeasureKind = 'color' | 'placeholder' | 'fill' | 'stroke' | 'boundary';

export type MeasureTarget = { element: Element; kind: MeasureKind };

const ICON_CONTROL_SELECTOR = 'button, a, [role="button"], [role="tab"]';

const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'hidden', 'file', 'button', 'submit']);

/**
 * Purely decorative elements, marked by hand in the markup, which stand for no label and are not
 * measured. Only the signature pad's animated pen hint is marked; icons in general stay measured.
 */
const DECORATIVE_SELECTOR = '[data-branding-decorative]';

const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

const colourCache = new Map<string, Rgba | null>();

let canvasContext: CanvasRenderingContext2D | null | undefined;

/** A colour the canvas reads; null when the canvas rejects the value (the two sentinels read back differently). */
const readThroughCanvas = (value: string): Rgba | null => {
  if (canvasContext === undefined) {
    const canvas = document.createElement('canvas');

    canvas.width = 1;
    canvas.height = 1;
    canvasContext = canvas.getContext('2d', { willReadFrequently: true });
  }

  if (!canvasContext) {
    return null;
  }

  canvasContext.fillStyle = '#010203';
  canvasContext.fillStyle = value;

  const first = canvasContext.fillStyle;

  canvasContext.fillStyle = '#030201';
  canvasContext.fillStyle = value;

  if (canvasContext.fillStyle !== first) {
    return null;
  }

  canvasContext.clearRect(0, 0, 1, 1);
  canvasContext.fillRect(0, 0, 1, 1);

  const [r, g, b, a] = canvasContext.getImageData(0, 0, 1, 1).data;

  return { r, g, b, a: a / 255 };
};

/** A computed colour as sRGB, or null when neither our parser nor the canvas reads it. */
export const readComputedColour = (value: string): Rgba | null => {
  if (colourCache.has(value)) {
    return colourCache.get(value) ?? null;
  }

  const colour = parseCssColour(value) ?? readThroughCanvas(value);

  if (colourCache.size > 500) {
    colourCache.clear();
  }

  colourCache.set(value, colour);

  return colour;
};

const isTextEditable = (element: Element): element is HTMLInputElement | HTMLTextAreaElement => {
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }

  return element instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(element.type);
};

const hasOwnText = (element: Element) =>
  Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());

const isVisible = (element: Element, style: CSSStyleDeclaration, svgRoot: Element) => {
  if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) {
    return false;
  }

  const rect = svgRoot.getBoundingClientRect();

  if (rect.width === 0 || rect.height === 0) {
    return false;
  }

  if (element.closest('[disabled], [hidden]')) {
    return false;
  }

  // Icons carry aria-hidden but are still seen, so it hides only elements outside an SVG.
  return svgRoot !== element || !element.closest('[aria-hidden="true"]');
};

/**
 * Points per side of the grid `paintsFill` samples inside a shape's bounding box. The grid keeps
 * off the box's edges: Chromium's `isPointInFill` is true at the endpoints of an open line, which
 * sit on its box's corners, though such a line paints no fill.
 */
const FILL_GRID = 7;

/**
 * Whether a shape's fill paints anything (round 18): an SVG geometry element counts only when
 * `isPointInFill` holds at one point of a grid over its bounding box, so open lines such as an X
 * icon's paths, which enclose no area, are not measured on a fill that never paints. Other SVG
 * elements count as before.
 */
const paintsFill = (element: Element) => {
  if (!(element instanceof SVGGeometryElement)) {
    return true;
  }

  const box = element.getBBox();

  for (let i = 0; i < FILL_GRID; i++) {
    for (let j = 0; j < FILL_GRID; j++) {
      const point = new DOMPoint(
        box.x + (box.width * (i + 1)) / (FILL_GRID + 1),
        box.y + (box.height * (j + 1)) / (FILL_GRID + 1),
      );

      if (element.isPointInFill(point)) {
        return true;
      }
    }
  }

  return false;
};

const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch']);

/** Input types that draw no field boundary of their own. */
const UNBOUNDED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'range', 'color', 'file']);

/**
 * Whether `element` is a control the guard judges by its boundary (rounds 20 and 21, WCAG 2.2
 * SC 1.4.11), as `readControlBoundaries` in `packages/app-tests/e2e/fixtures/branding-contrast.ts`
 * does: every field (`input` of a type that draws a box, `textarea`, `select`) whatever it holds,
 * and a checkbox, radio, switch or button that shows no text and holds no icon, unless it is
 * `aria-disabled`.
 */
const isBoundaryControl = (element: Element) => {
  const isField =
    (element instanceof HTMLInputElement && !UNBOUNDED_INPUT_TYPES.has(element.type)) ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement;
  const isToggle =
    (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) ||
    TOGGLE_ROLES.has(element.getAttribute('role') ?? '');
  const isEmptyButton =
    element instanceof HTMLButtonElement && (element.textContent ?? '').trim() === '' && element.value === '';

  return (
    (isField || ((isToggle || isEmptyButton) && !element.querySelector('svg'))) &&
    element.getAttribute('aria-disabled') !== 'true'
  );
};

/**
 * Every measurement in `root` and its descendants. A text input or textarea is measured for its
 * text colour whether or not it holds a value yet, since the signer is about to type into it.
 */
export const collectTargets = (root: Element): MeasureTarget[] => {
  const targets: MeasureTarget[] = [];

  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (SKIPPED_TAGS.has(element.tagName) || element.closest(DECORATIVE_SELECTOR)) {
      continue;
    }

    const style = getComputedStyle(element);
    const svgRoot = element instanceof SVGElement ? (element.ownerSVGElement ?? element) : element;

    if (!isVisible(element, style, svgRoot)) {
      continue;
    }

    const isEditable = isTextEditable(element);

    if (isEditable || hasOwnText(element)) {
      targets.push({ element, kind: 'color' });
    }

    if (isEditable && element.value === '' && element.placeholder) {
      targets.push({ element, kind: 'placeholder' });
    }

    if (isBoundaryControl(element)) {
      targets.push({ element, kind: 'boundary' });
    }

    if (svgRoot !== element && element.closest(ICON_CONTROL_SELECTOR)) {
      if (style.stroke !== 'none') {
        targets.push({ element, kind: 'stroke' });
      }

      if (style.fill !== 'none' && paintsFill(element)) {
        targets.push({ element, kind: 'fill' });
      }
    }
  }

  return targets;
};

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/** Source-over compositing of `top` on `bottom`, either of which may be translucent. */
const over = (top: Rgba, bottom: Rgba): Rgba => {
  const a = top.a + bottom.a * (1 - top.a);

  if (a === 0) {
    return TRANSPARENT;
  }

  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;

  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
};

/** The page behind a glyph (`bg`) and the same with the glyph painted on it (`text`). */
type Painted = { bg: Rgba; text: Rgba };

/**
 * A contrast reader for one style state. Each ancestor's `background-color` is painted from the
 * root down over white, skipping elements inside an `<svg>`, whose backgrounds are never painted;
 * background images, gradients included, are not sampled. An element with `opacity` below 1 is an
 * isolated group (round 15): its background, its descendants and the glyph are painted on
 * transparent, then composited at that opacity over the backdrop beneath it, as
 * `readability` in `packages/app-tests/e2e/fixtures/branding-contrast.ts` does. Computed styles
 * are memoised, so the reader must not outlive a change of style (`createContrastReader` again
 * after toggling a stylesheet). A colour that cannot be read gives Infinity, so the guard never
 * disables a stylesheet on a value it cannot read.
 */
export const createContrastReader = () => {
  const layers = new Map<Element, { background: Rgba | null; opacity: number }>();

  const layerOf = (element: Element) => {
    let layer = layers.get(element);

    if (!layer) {
      const style = getComputedStyle(element);
      // The browser paints no background for elements inside an <svg>, only for the <svg> box.
      const isInsideSvg = element instanceof SVGElement && element.ownerSVGElement !== null;

      layer = {
        background: isInsideSvg ? TRANSPARENT : readComputedColour(style.backgroundColor),
        opacity: Number(style.opacity),
      };
      layers.set(element, layer);
    }

    return layer;
  };

  /** Paints `chain[index]` and everything above it on `backdrop`; null when a colour cannot be read. */
  const paint = (chain: Element[], index: number, backdrop: Painted, top: Rgba, glyph: Rgba): Painted | null => {
    const { background, opacity } = layerOf(chain[index]);

    if (!background) {
      return null;
    }

    const isIsolated = opacity < 1;
    const start = isIsolated ? { bg: TRANSPARENT, text: TRANSPARENT } : backdrop;
    let painted: Painted | null = { bg: over(background, start.bg), text: over(background, start.text) };

    if (index < chain.length - 1) {
      painted = paint(chain, index + 1, painted, top, glyph);
    } else {
      const bg = over(top, painted.bg);

      painted = { bg, text: over(glyph, over(top, painted.text)) };
    }

    if (!painted || !isIsolated) {
      return painted;
    }

    const fade = (colour: Rgba): Rgba => ({ ...colour, a: colour.a * opacity });

    return { bg: over(fade(painted.bg), backdrop.bg), text: over(fade(painted.text), backdrop.text) };
  };

  /**
   * A control's boundary (round 20): the better of its own background and each border side that
   * paints (width above 0, style not none or hidden), each against the background behind it, its
   * parent's as painted. An erased boundary reads about 1:1 like any other; the guard compares it
   * with the default theme without a margin (round 22), and excludes controls that paint nothing
   * there (`paintsNoBoundary`).
   */
  const readBoundary = (element: Element): number => {
    const chain: Element[] = [];

    for (let node = element.parentElement; node; node = node.parentElement) {
      chain.unshift(node);
    }

    const behind = chain.length > 0 ? paint(chain, 0, { bg: WHITE, text: WHITE }, TRANSPARENT, TRANSPARENT)?.bg : WHITE;
    const style = getComputedStyle(element);
    const ownLayer = readComputedColour(style.backgroundColor);

    if (!behind || !ownLayer) {
      return Infinity;
    }

    const own = over(ownLayer, behind);
    let best = contrastRatio(own, behind);

    for (const side of ['top', 'right', 'bottom', 'left']) {
      const kind = style.getPropertyValue(`border-${side}-style`);

      if (
        !(Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0) ||
        kind === 'none' ||
        kind === 'hidden'
      ) {
        continue;
      }

      const colour = readComputedColour(style.getPropertyValue(`border-${side}-color`));

      if (!colour) {
        return Infinity;
      }

      best = Math.max(best, contrastRatio(over(colour, own), behind));
    }

    return best;
  };

  return ({ element, kind }: MeasureTarget): number => {
    if (kind === 'boundary') {
      return readBoundary(element);
    }

    let style = getComputedStyle(element);
    let top = TRANSPARENT;

    if (kind === 'placeholder') {
      style = getComputedStyle(element, '::placeholder');

      const own = readComputedColour(style.backgroundColor);

      if (!own) {
        return Infinity;
      }

      top = own;
    }

    const foreground = readComputedColour(kind === 'fill' || kind === 'stroke' ? style[kind] : style.color);

    if (!foreground) {
      return Infinity;
    }

    const chain: Element[] = [];

    for (let node: Element | null = element; node; node = node.parentElement) {
      chain.unshift(node);
    }

    const painted = paint(chain, 0, { bg: WHITE, text: WHITE }, top, foreground);

    return painted ? contrastRatio(painted.text, painted.bg) : Infinity;
  };
};

/**
 * True when a control draws no boundary at all: no background colour or image of its own, and every
 * border side that paints is fully transparent, such as the signature field's click overlay. The
 * guard reads this in the default theme and excludes such controls from the boundary rule, as
 * `readControlBoundaries` in the e2e fixtures does (round 22).
 */
export const paintsNoBoundary = (element: Element): boolean => {
  const style = getComputedStyle(element);

  if ((readComputedColour(style.backgroundColor)?.a ?? 0) > 0 || style.backgroundImage !== 'none') {
    return false;
  }

  return ['top', 'right', 'bottom', 'left'].every((side) => {
    const kind = style.getPropertyValue(`border-${side}-style`);

    if (
      !(Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0) ||
      kind === 'none' ||
      kind === 'hidden'
    ) {
      return true;
    }

    return (readComputedColour(style.getPropertyValue(`border-${side}-color`))?.a ?? 0) === 0;
  });
};

const COLOUR_PROPERTY = /^(all|color|fill|stroke|background|background-color|border|outline|text-decoration|opacity)/;

/**
 * Elements whose painted colours are mid-change: the targets of running transitions and
 * animations that touch a colour property or `opacity` (round 16, for the dialog's entrance
 * fade). A label takes its background and its opacity from its ancestors, so a target is
 * unsettled when it or any ancestor is in this set. Transform-only animations, such as a spinner,
 * do not count.
 */
export const findColourAnimations = (): Map<Element, Animation[]> => {
  const animating = new Map<Element, Animation[]>();

  for (const animation of document.getAnimations()) {
    const effect = animation.effect;

    if (animation.playState !== 'running' || !(effect instanceof KeyframeEffect) || !effect.target) {
      continue;
    }

    const properties =
      animation instanceof CSSTransition
        ? [animation.transitionProperty]
        : effect.getKeyframes().flatMap((frame) => Object.keys(frame));

    const kebab = properties.map((name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`));

    if (kebab.some((name) => COLOUR_PROPERTY.test(name))) {
      animating.set(effect.target, [...(animating.get(effect.target) ?? []), animation]);
    }
  }

  return animating;
};
