/** Media helpers for the signing-page branding guard. */

/** Every media condition in the stylesheet, nested rules included, so a change to any of them re-measures. */
export const findMediaQueries = (rules: CSSRuleList | undefined, into = new Set<string>()): Set<string> => {
  for (const rule of Array.from(rules ?? [])) {
    if (rule instanceof CSSMediaRule) {
      into.add(rule.media.mediaText);
    }

    if ('cssRules' in rule) {
      findMediaQueries((rule as CSSGroupingRule).cssRules, into);
    }
  }

  return into;
};

/** Rewrites `print` to `all` in every media condition, so the copy applies its print rules on screen. */
export const applyPrintRules = (rules: CSSRuleList | undefined) => {
  for (const rule of Array.from(rules ?? [])) {
    if (rule instanceof CSSMediaRule && /\bprint\b/i.test(rule.media.mediaText)) {
      rule.media.mediaText = rule.media.mediaText.replace(/\bprint\b/gi, 'all');
    }

    if ('cssRules' in rule) {
      applyPrintRules((rule as CSSGroupingRule).cssRules);
    }
  }
};
