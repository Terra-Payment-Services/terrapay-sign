import valueParser from 'postcss-value-parser';

import { asciiLowerCase, compositeColour, parseCssColour, type Rgba } from './parse-css-colour';

/** A colour as the warnings print it: the value as written, and what it denotes. */
export type Paint = { colour: Rgba; text: string };

/** The solid background a rule paints after one of its background declarations. */
export type BackgroundState = { colour: Paint | null; text: string };

/** Why a background declaration is not read: a gradient, or a grammar the check does not model. */
export type BackgroundRefusal = { refused: 'gradient' | 'unsupported'; text: string };

const COLOUR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

/** The colour a value node denotes, or null when it is not one of the allowed colour forms. */
const readColourNode = (node: valueParser.Node): Rgba | null => {
  if (node.type === 'word') {
    return parseCssColour(node.value);
  }

  if (node.type === 'function' && COLOUR_FUNCTIONS.has(asciiLowerCase(node.value))) {
    return parseCssColour(valueParser.stringify(node));
  }

  return null;
};

/** Splits a node list at its top-level commas, dropping whitespace nodes. */
const splitAtCommas = (nodes: valueParser.Node[]): valueParser.Node[][] => {
  const groups: valueParser.Node[][] = [[]];

  for (const node of nodes) {
    if (node.type === 'div' && node.value === ',') {
      groups.push([]);
    } else if (node.type !== 'space') {
      groups[groups.length - 1].push(node);
    }
  }

  return groups;
};

const isNone = (node: valueParser.Node) => node.type === 'word' && asciiLowerCase(node.value) === 'none';

const hasGradient = (nodes: valueParser.Node[]) =>
  nodes.some((node) => node.type === 'function' && asciiLowerCase(node.value).includes('gradient'));

/**
 * The solid colour a `background`, `background-color` or `background-image` declaration sets, or
 * why it is not read. Gradients are not evaluated: any gradient refuses the declaration.
 * `background-color` is one colour; `background-image` is `none`; the `background` shorthand is
 * layers of `none` with at most one colour, and `none`, in the last. Anything else, including an
 * empty layer, positions, sizes, repeats and boxes, is unsupported.
 *
 * @param prop the property, lowercase
 * @param value the declared value
 * @returns the colour it sets (null resets it to none), or a refusal
 */
export const readBackgroundDeclaration = (prop: string, value: string): BackgroundState | BackgroundRefusal => {
  const nodes = value.includes('\\') ? null : valueParser(value).nodes;

  if (nodes && hasGradient(nodes)) {
    return { refused: 'gradient', text: value };
  }

  const unsupported: BackgroundRefusal = { refused: 'unsupported', text: value };

  if (!nodes) {
    return unsupported;
  }

  if (prop === 'background-color') {
    const colour = parseCssColour(value);

    return colour ? { colour: { colour, text: value }, text: value } : unsupported;
  }

  const layers = splitAtCommas(nodes);
  const last = layers[layers.length - 1];
  const others = layers.slice(0, -1);

  if (others.some((layer) => layer.length !== 1 || !isNone(layer[0]))) {
    return unsupported;
  }

  if (prop === 'background-image') {
    return last.length === 1 && isNone(last[0]) ? { colour: null, text: value } : unsupported;
  }

  const colours = last.filter((node) => readColourNode(node) !== null);
  const nones = last.filter(isNone);

  if (last.length === 0 || colours.length > 1 || nones.length > 1 || colours.length + nones.length !== last.length) {
    return unsupported;
  }

  const colour = colours.length === 1 ? (readColourNode(colours[0]) as Rgba) : null;

  return { colour: colour ? { colour, text: valueParser.stringify(colours[0]) } : null, text: value };
};

/** The opaque colour a state shows over `page`. */
export const backgroundSurface = (state: BackgroundState, page: Rgba): Rgba =>
  state.colour ? compositeColour(state.colour.colour, page) : page;

/** Keywords that let a background show what lies beneath it, or take it from elsewhere. */
const SEE_THROUGH_KEYWORDS = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
]);

/**
 * True unless every colour in `nodes`, gradient stops included, is one the colour parser reads at
 * alpha 1 (round 17: opacity is proven, not assumed). Outside a gradient the only other word
 * allowed is `none`; inside one, words the parser does not read as colours (directions, positions,
 * lengths) are left to the round 2 rule, which drops every gradient anyway.
 */
const hasUnprovenColour = (nodes: valueParser.Node[], isInGradient = false): boolean =>
  nodes.some((node) => {
    if (node.type === 'space' || node.type === 'div') {
      return false;
    }

    if (node.type === 'function' && asciiLowerCase(node.value).includes('gradient')) {
      return hasUnprovenColour(node.nodes, true);
    }

    if (node.type === 'word' && SEE_THROUGH_KEYWORDS.has(asciiLowerCase(node.value))) {
      return true;
    }

    const colour = readColourNode(node);

    if (colour) {
      return colour.a < 1;
    }

    return node.type !== 'word' || !(isInGradient || asciiLowerCase(node.value) === 'none');
  });

/**
 * Why a tenant background declaration is refused for not being opaque, or null (rounds 16
 * and 17). A see-through tenant background exposes app paint the guard does not read, such as a
 * dialog overlay, so every colour in `background-color`, `background` and `background-image`,
 * gradient stops included, must be one the colour parser reads at alpha 1, and `background` must
 * paint an opaque colour or a gradient.
 * Gradients themselves are still refused by the round 2 rule in the contrast check.
 *
 * @param prop the property, lowercase
 * @param value the declared value, with CSS escapes decoded
 */
export const findSeeThroughBackground = (prop: string, value: string): string | null => {
  if (prop !== 'background-color' && prop !== 'background' && prop !== 'background-image') {
    return null;
  }

  const nodes = valueParser(value).nodes;
  const colour = prop === 'background-color' ? parseCssColour(value) : null;

  if (prop === 'background-color' ? colour?.a !== 1 : hasUnprovenColour(nodes)) {
    return 'a background must be an opaque colour';
  }

  if (prop === 'background' && !hasGradient(nodes) && !nodes.some((node) => readColourNode(node) !== null)) {
    return 'a background must paint an opaque colour';
  }

  return null;
};
