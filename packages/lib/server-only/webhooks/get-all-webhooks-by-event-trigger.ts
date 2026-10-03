import { prisma } from '@documenso/prisma';
import type { Prisma, WebhookTriggerEvents } from '@prisma/client';

import { buildTeamWhereQuery } from '../../utils/teams';

export type GetAllWebhooksByEventTriggerOptions = {
  event: WebhookTriggerEvents;
  userId: number;
  teamId: number;
};

export type GetTeamWebhooksByEventTriggerOptions = {
  event: WebhookTriggerEvents;
  teamId: number;
};

const findEnabledWebhooks = async (
  event: WebhookTriggerEvents,
  team: Prisma.TeamWhereUniqueInput | Prisma.TeamWhereInput,
) =>
  await prisma.webhook.findMany({
    where: {
      enabled: true,
      eventTriggers: {
        has: event,
      },
      team,
    },
  });

/**
 * Count the team's subscriptions to an event without any membership scoping.
 *
 * Only ever used to explain an empty result, never to deliver from.
 */
const countTeamWebhooks = async (event: WebhookTriggerEvents, teamId: number) =>
  await prisma.webhook.count({
    where: {
      enabled: true,
      eventTriggers: {
        has: event,
      },
      team: {
        id: teamId,
      },
    },
  });

/**
 * Read the webhooks a user can see on a team, for events raised while that user
 * is acting.
 *
 * `userId` is the acting principal and is required. The membership clause it
 * builds is an access check, so a background job must not reach for this
 * function and pass whatever user happens to be attached to the record it is
 * working on. `getTeamWebhooksByEventTrigger` is the entry point for that.
 *
 * ## Why an empty result is sometimes worth a line in the log
 *
 * Zero webhooks is the normal state for a team that has configured none, and
 * warning about it would put a line against every document event for most
 * teams. The case worth hearing about is the other one: the team does hold
 * subscriptions to this event and the membership clause hid them, which is a
 * notification the team was owed and will never get. Those two are told apart
 * by counting the team's subscriptions with the scoping removed, which happens
 * only when the scoped read came back empty.
 *
 * @param options - the event, the acting user, and the team the record belongs to
 * @returns the enabled webhooks that user can see for that event
 */
export const getAllWebhooksByEventTrigger = async ({ event, userId, teamId }: GetAllWebhooksByEventTriggerOptions) => {
  const webhooks = await findEnabledWebhooks(event, buildTeamWhereQuery({ teamId, userId }));

  if (webhooks.length > 0) {
    return webhooks;
  }

  // Diagnostic only. A failure to explain the empty result must not become a
  // failure to resolve it, so nothing here is allowed to throw.
  await countTeamWebhooks(event, teamId)
    .then((teamWebhookCount) => {
      if (teamWebhookCount === 0) {
        return;
      }

      console.warn(
        `[webhooks] Team ${teamId} has ${teamWebhookCount} enabled ${event} webhook(s) that user ${userId} cannot see. Nothing will be delivered for this event.`,
      );
    })
    .catch((err: unknown) => {
      console.error('[webhooks] Failed to check whether team', teamId, 'has hidden', event, 'webhooks', err);
    });

  return webhooks;
};

/**
 * Read a team's webhooks for events raised by a background job.
 *
 * There is no acting user in a job. Scoping by the author's membership is what
 * the seal job used to do, and it resolved nothing once the author lost team
 * access, so a contract the whole team had signed completed without anybody
 * being told. Authorisation for the record was settled when a request created
 * it. What the job needs now is the team the record belongs to.
 *
 * Deliberately a separate function rather than an optional `userId` on the one
 * above, so that dropping the scoping is something a caller has to choose.
 *
 * @param options - the event and the team the record belongs to
 * @returns every enabled webhook the team holds for that event
 */
export const getTeamWebhooksByEventTrigger = async ({ event, teamId }: GetTeamWebhooksByEventTriggerOptions) =>
  await findEnabledWebhooks(event, { id: teamId });
