import type { Webhook, WebhookTriggerEvents } from '@prisma/client';

import { jobs } from '../../../jobs/client';
import { getAllWebhooksByEventTrigger, getTeamWebhooksByEventTrigger } from '../get-all-webhooks-by-event-trigger';

export type TriggerWebhookOptions = {
  event: WebhookTriggerEvents;
  data: Record<string, unknown>;
  userId: number;
  teamId: number;
};

export type TriggerTeamWebhookOptions = {
  event: WebhookTriggerEvents;
  data: Record<string, unknown>;
  teamId: number;
};

/**
 * Queue one delivery job per webhook registered against an event.
 *
 * ## Why a failed enqueue has to be a failure
 *
 * Callers wrap this in `io.runTask`, which writes a completion marker when the
 * callback resolves and never runs the step again for that job. Resolving after
 * every enqueue was rejected therefore writes "the webhooks went out" over a
 * run in which none did, and the seal retry skips the step for good. The
 * integration is then silently dead for that document, and the only way anybody
 * finds out is a partner asking why they were never told.
 *
 * A partial failure fails the whole call, which means a retry re-queues the
 * deliveries that did get through. That is deliberate. Webhook delivery is
 * at-least-once anyway, receivers are expected to tolerate a repeat, and a
 * duplicate notification is a far smaller problem than one that never arrives.
 */
const queueDeliveries = async (
  event: WebhookTriggerEvents,
  data: Record<string, unknown>,
  resolve: () => Promise<Pick<Webhook, 'id'>[]>,
) => {
  const registeredWebhooks = await resolve().catch((err: unknown) => {
    console.error('[webhooks] Failed to read the webhooks registered for', event, err);

    throw new Error(`Failed to read the webhooks registered for ${event}`, {
      cause: err,
    });
  });

  if (registeredWebhooks.length === 0) {
    return;
  }

  const outcomes = await Promise.allSettled(
    registeredWebhooks.map(
      async (webhook) =>
        await jobs.triggerJob({
          name: 'internal.execute-webhook',
          payload: {
            event,
            webhookId: webhook.id,
            data,
          },
        }),
    ),
  );

  const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');

  if (rejected.length === 0) {
    return;
  }

  for (const failure of rejected) {
    console.error('[webhooks] Failed to queue a', event, 'delivery', failure.reason);
  }

  throw new Error(
    `Failed to queue ${rejected.length} of ${outcomes.length} ${event} webhook deliveries`,
    // Keep the first cause. Every rejection is already logged above, and the
    // message a caller records against a failed job should stay short enough to
    // sit in a column.
    { cause: rejected[0].reason },
  );
};

/**
 * Fan an event out to the webhooks the acting user can see on a team.
 *
 * For request contexts, where `userId` is the principal the request
 * authenticated as and the membership clause it builds is load-bearing. A
 * background job has no such principal and must call `triggerTeamWebhook`.
 *
 * @param options - the event, its payload, the acting user, and the team
 * @throws {Error} when the webhooks cannot be read, or any delivery cannot be queued
 */
export const triggerWebhook = async ({ event, data, userId, teamId }: TriggerWebhookOptions) =>
  await queueDeliveries(event, data, async () => await getAllWebhooksByEventTrigger({ event, userId, teamId }));

/**
 * Fan an event out to every webhook a team holds, with no membership scoping.
 *
 * For background jobs. The record the job is working on carries a team, and
 * that team is who the notification is owed to, whatever has since happened to
 * the membership of the user who created it.
 *
 * @param options - the event, its payload, and the team the record belongs to
 * @throws {Error} when the webhooks cannot be read, or any delivery cannot be queued
 */
export const triggerTeamWebhook = async ({ event, data, teamId }: TriggerTeamWebhookOptions) =>
  await queueDeliveries(event, data, async () => await getTeamWebhooksByEventTrigger({ event, teamId }));
