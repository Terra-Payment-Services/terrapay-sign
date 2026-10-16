import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as asn1js from 'asn1js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ABSURD_NULLS,
  buildAbsurdSignedPdf,
  buildLargeSignedPdf,
  buildSmallSignedPdf,
  signatureCms,
  tamperCoveredByte,
} from '../../lib/server-only/pdf/__fixtures__/large-signature';
import {
  assertEmbeddedSignaturesIntact,
  EmbeddedSignatureBrokenError,
  inspectEmbeddedSignatures,
} from './embedded-signatures';

/**
 * Isolated: signatures whose CMS needs more than 10,000 ASN.1 nodes.
 *
 * Written from the specification and the exports' signatures and JSDoc only.
 * The upload route is covered by
 * packages/app-tests/e2e/scenarios/large-signature-upload.spec.ts; this file
 * exists for criterion 3, the upper bound, which the upload route cannot reach
 * at sensible cost, and pins criteria 1, 2 and 4 at the same seam.
 *
 * Failure modes:
 * - F1, the defect: an intact signature whose CMS needs more than 10,000
 *   nodes is reported skipped ("carries no message digest") instead of intact,
 *   so the arrival check refuses a good upload.
 * - F2: once such a CMS parses, a file altered under it is accepted, or is
 *   reported skipped rather than broken. Skipped is still refused at arrival,
 *   but a storage-time check that lets skipped through would store a broken
 *   signature, so broken is the right answer for a CMS that parses.
 * - F3: the node limit is removed rather than raised, so a CMS built to need
 *   hundreds of thousands of nodes is parsed in full and reported intact. One
 *   such upload costs hundreds of megabytes of heap (measured below).
 * - F4: the change alters how an ordinary small signature is judged: an
 *   intact one is no longer intact, or a tampered one is no longer broken.
 * - The fixture drifts under the boundary, or stops being a valid signature,
 *   and the tests above pass or fail for that reason instead. Guarded by
 *   preconditions on the node count, through asn1js itself, and on poppler
 *   pdfsig, which shares no code with Sign.
 *
 * What this seam misses compared with E2E: whether the upload routes call the
 * check, and whether the stored file keeps the signature. The E2E spec covers
 * those for criteria 1, 2 and 4.
 *
 * The bound (criterion 3). The absurd fixture needs just over 500,000 nodes,
 * so the bound the fix chooses must sit below 500,000. Measured on asn1js
 * 3.0.10 under Node 26 on 2026-10-14, parsing one million NULLs took 560 ms
 * and 593 MB of heap, about 600 bytes per node, so 500,000 nodes is about
 * 300 MB for a single signature. The upload limit is 50 MiB, and a hex
 * /Contents of that size holds up to about 12.5 million two-byte nodes, so
 * without a bound one upload could ask for several gigabytes. The only real
 * signature measured, the reported PandaDoc one, needed under 20,000. Where
 * the bound sits between that and 500,000 is for the fix to choose; this test
 * only holds it under 500,000.
 */

let workDir: string;
let small: Buffer;
let large: Buffer;
let absurd: Buffer;

const parsesWithin = (der: Buffer, maxNodes: number) => asn1js.fromBER(der, { maxNodes }).offset !== -1;

const pdfsigValidation = (bytes: Buffer) => {
  const file = path.join(workDir, `pdfsig-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);

  fs.writeFileSync(file, bytes);

  const { stdout } = spawnSync('pdfsig', [file], { encoding: 'utf8' });

  return /- Signature Validation: (.*)$/m.exec(stdout)?.[1]?.trim() ?? '';
};

const outcomeOf = async (bytes: Buffer) =>
  await inspectEmbeddedSignatures(new Uint8Array(bytes)).then(
    (report) => ({ resolved: report }),
    (error: unknown) => ({ rejected: error }),
  );

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'large-cms-60-'));
  small = await buildSmallSignedPdf();
  large = await buildLargeSignedPdf();
  absurd = await buildAbsurdSignedPdf();
}, 120_000);

describe('fixture preconditions', () => {
  it('the large fixture needs between 10,000 and 20,000 nodes, like the reported signature', () => {
    const cms = signatureCms(large);

    expect(parsesWithin(cms, 10_000), 'asn1js stops at 10,000 nodes on this CMS').toBe(false);
    expect(parsesWithin(cms, 20_000), 'and parses it within 20,000').toBe(true);
    expect(cms.length, 'roughly the size of the reported one (91,064 bytes)').toBeGreaterThan(80_000);
  });

  it('the absurd fixture needs more than 500,000 nodes and is still a complete CMS', () => {
    const cms = signatureCms(absurd);

    expect(parsesWithin(cms, ABSURD_NULLS), 'more than 500,000 nodes').toBe(false);
    expect(parsesWithin(cms, Number.POSITIVE_INFINITY), 'and complete when parsed without a limit').toBe(true);
    // Two parses of half a million nodes: 5.3 s on dev's shared runner (CI job 179897).
  }, 60_000);

  it('the small fixture parses well within 10,000 nodes', () => {
    expect(parsesWithin(signatureCms(small), 1_000)).toBe(true);
  });

  it('poppler verifies every intact fixture and finds the tampered ones broken', () => {
    expect(pdfsigValidation(small), 'small').toBe('Signature is Valid.');
    expect(pdfsigValidation(large), 'large').toBe('Signature is Valid.');
    expect(pdfsigValidation(absurd), 'absurd').toBe('Signature is Valid.');
    expect(pdfsigValidation(tamperCoveredByte(large)), 'large, tampered').toBe('Digest Mismatch.');
    expect(pdfsigValidation(tamperCoveredByte(small)), 'small, tampered').toBe('Digest Mismatch.');
  });
});

describe('Signatures that need more than 10,000 ASN.1 nodes', () => {
  it('criterion_1_intact_signature_needing_over_10000_nodes_is_reported_intact', async () => {
    expect(await inspectEmbeddedSignatures(new Uint8Array(large))).toEqual({ checked: 1, intact: 1, skipped: [] });
  });

  it('criterion_1_intact_signature_needing_over_10000_nodes_passes_the_storage_check', async () => {
    const report = await assertEmbeddedSignaturesIntact(new Uint8Array(large));

    expect(report).toEqual({ checked: 1, intact: 1, skipped: [] });
  });

  it('criterion_2_large_signature_over_altered_bytes_is_broken_not_skipped', async () => {
    const outcome = await outcomeOf(tamperCoveredByte(large));

    expect('rejected' in outcome, `the check must call it broken; it resolved with ${JSON.stringify(outcome)}`).toBe(
      true,
    );
    expect((outcome as { rejected: unknown }).rejected).toBeInstanceOf(EmbeddedSignatureBrokenError);
  });

  it('criterion_3_signature_needing_over_500000_nodes_is_not_treated_as_verified', async () => {
    const outcome = await outcomeOf(absurd);

    if ('rejected' in outcome) {
      // Calling it broken also keeps it out; what must not happen is intact.
      expect(outcome.rejected).toBeInstanceOf(EmbeddedSignatureBrokenError);

      return;
    }

    expect(outcome.resolved.checked, 'the document loaded and its signature was found').toBe(1);
    expect(outcome.resolved.intact, `not verified: ${JSON.stringify(outcome.resolved)}`).toBe(0);
    expect(outcome.resolved.skipped).toHaveLength(1);
  }, 60_000);

  it('criterion_4_small_intact_signature_is_reported_intact', async () => {
    expect(await inspectEmbeddedSignatures(new Uint8Array(small))).toEqual({ checked: 1, intact: 1, skipped: [] });
  });

  it('criterion_4_small_signature_over_altered_bytes_is_broken', async () => {
    await expect(assertEmbeddedSignaturesIntact(new Uint8Array(tamperCoveredByte(small)))).rejects.toThrow(
      EmbeddedSignatureBrokenError,
    );
  });
});
