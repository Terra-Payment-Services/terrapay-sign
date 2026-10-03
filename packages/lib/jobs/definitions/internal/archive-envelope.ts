import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const ARCHIVE_ENVELOPE_JOB_DEFINITION_ID = 'internal.archive-envelope';

const ARCHIVE_ENVELOPE_JOB_DEFINITION_SCHEMA = z.object({
  envelopeId: z.string(),
});

export type TArchiveEnvelopeJobDefinition = z.infer<typeof ARCHIVE_ENVELOPE_JOB_DEFINITION_SCHEMA>;

/**
 * File the sealed documents of one completed envelope into the SharePoint
 * contract library.
 *
 * This is an archival copy. The sealed PDF in object storage stays the system
 * of record; SharePoint receives a copy so that the retention, eDiscovery and
 * sensitivity labelling configured on that library apply to executed contracts.
 *
 * The job is triggered twice over, and both paths matter:
 *
 *  1. `seal-document` fires it once the envelope reaches COMPLETED, which is
 *     the timely path. That trigger is deliberately swallowed on failure, so a
 *     SharePoint outage, or a Redis outage, cannot fail the seal.
 *  2. `archive-envelope-sweep` fires it for anything still unfiled, which is
 *     the path that actually carries the guarantee. Events are lost to crashes,
 *     deploys and queue evictions, and a lost event that nobody notices is
 *     exactly the failure this feature exists to prevent.
 *
 * Running twice is harmless. A document already recorded as filed is skipped,
 * and one being filed right now is left alone, because every attempt has to win
 * a claim on the document before it may upload. The claim is a lease, so a run
 * that dies mid-upload releases the document to a later sweep rather than
 * holding it forever.
 *
 * The job throws when a document could not be filed, which surfaces the failure
 * in Bull Board and takes the job system's retry. Those retries are quick
 * enough that they arrive while this run still holds the claim, so they find
 * nothing to do and it is the sweep that files the document twenty minutes
 * later. A late copy costs nobody anything. A second copy of an executed
 * contract in a library under retention is a mess somebody has to clean up by
 * hand.
 */
export const ARCHIVE_ENVELOPE_JOB_DEFINITION = {
  id: ARCHIVE_ENVELOPE_JOB_DEFINITION_ID,
  name: 'Archive Envelope To SharePoint',
  version: '1.0.0',
  trigger: {
    name: ARCHIVE_ENVELOPE_JOB_DEFINITION_ID,
    schema: ARCHIVE_ENVELOPE_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./archive-envelope.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<typeof ARCHIVE_ENVELOPE_JOB_DEFINITION_ID, TArchiveEnvelopeJobDefinition>;
