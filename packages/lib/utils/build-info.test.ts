import { describe, expect, it } from 'vitest';

import { describeBuild } from './build-info';

describe('describeBuild', () => {
  it('shows the release tag, with commit, build time and upstream base beneath it', () => {
    expect(
      describeBuild(
        {
          appVersion: 'v0.3.0',
          gitSha: 'fc4f8fa5515b9dc3d7cc91c500623b28058a5d2e',
          buildTimestamp: '2026-10-03T08:52:17Z',
        },
        '2.18.0',
      ),
    ).toEqual({ release: 'v0.3.0', detail: 'fc4f8fa55 · 2026-10-03 08:52Z · Documenso 2.18.0' });
  });

  it('calls an unstamped build dev, and never passes off the upstream version as ours', () => {
    expect(describeBuild({}, '2.18.0')).toEqual({ release: 'dev', detail: 'Documenso 2.18.0' });
    expect(describeBuild({ appVersion: ' ', gitSha: '' }, '2.18.0').release).toBe('dev');
  });
});
