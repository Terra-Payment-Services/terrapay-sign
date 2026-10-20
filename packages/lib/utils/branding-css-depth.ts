import type { Root } from 'postcss';

/** Rules and at-rules nested deeper than this refuse the stylesheet. */
export const MAX_BRANDING_CSS_DEPTH = 8;

/**
 * Measures nesting without recursion, so a stylesheet nested thousands deep cannot exhaust the
 * stack here. The sanitiser and the contrast check recurse, so this runs before either.
 *
 * @returns true when a rule or at-rule sits deeper than MAX_BRANDING_CSS_DEPTH
 */
export const exceedsBrandingCssDepth = (root: Root): boolean => {
  const stack: { nodes: Root['nodes']; depth: number }[] = [{ nodes: root.nodes, depth: 0 }];

  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const { nodes, depth } = entry;

    for (const node of nodes) {
      if (node.type !== 'rule' && node.type !== 'atrule') {
        continue;
      }

      if (depth + 1 > MAX_BRANDING_CSS_DEPTH) {
        return true;
      }

      if (node.nodes) {
        stack.push({ nodes: node.nodes, depth: depth + 1 });
      }
    }
  }

  return false;
};
