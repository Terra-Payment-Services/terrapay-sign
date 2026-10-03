import type { WebhookTriggerEvents } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who a team's webhooks belong to, and who is allowed to resolve them.
 *
 * The seal job used to ask for them as the document's author. Membership here
 * comes from Entra groups and is reconciled on a schedule, so by the time the
 * last recipient signs, the author may have moved team or left. The query then
 * matched no team, returned an empty list, and the caller treated that as "this
 * team subscribes to nothing". A contract the whole team had signed completed
 * and the team's integration never heard a word.
 *
 * Prisma is stubbed with a fake that reads the `team` clause the code builds,
 * against a small table of teams and their members. The clause itself comes
 * from the real `buildTeamWhereQuery`, so a regression that swaps the scoped
 * read for the unscoped one, or the other way round, changes what these tests
 * see.
 */

type TeamRow = { id: number; memberIds: number[] };

type WebhookRow = { id: string; teamId: number; enabled: boolean; eventTriggers: string[] };

/** Team 1 belongs to user 1. User 9 was its author and is a member of nothing. */
const teams: TeamRow[] = [
  { id: 1, memberIds: [1] },
  { id: 2, memberIds: [7] },
];

let webhooks: WebhookRow[] = [];

let countFailure: Error | null = null;

/** The two team clauses the code under test can produce, as one readable shape. */
type TeamClause = {
  id?: number;
  teamGroups?: {
    some?: {
      organisationGroup?: {
        organisationGroupMembers?: {
          some?: {
            organisationMember?: { userId?: number };
          };
        };
      };
    };
  };
};

/**
 * Read the two team clauses the code under test can produce.
 *
 * `{ id }` alone is the unscoped read. The nested `teamGroups` shape is what
 * `buildTeamWhereQuery` returns, and the userId buried in it is the membership
 * the request path insists on.
 */
const matchTeams = (clause: TeamClause): number[] => {
  const teamId = clause.id;

  const scopedUserId =
    clause.teamGroups?.some?.organisationGroup?.organisationGroupMembers?.some?.organisationMember?.userId;

  return teams
    .filter((team) => teamId === undefined || team.id === teamId)
    .filter((team) => scopedUserId === undefined || team.memberIds.includes(scopedUserId))
    .map((team) => team.id);
};

const select = ({ where }: { where: Record<string, unknown> }) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const event = (where.eventTriggers as { has: string }).has;

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const visibleTeamIds = matchTeams(where.team as TeamClause);

  return webhooks.filter(
    (webhook) =>
      webhook.enabled === where.enabled &&
      webhook.eventTriggers.includes(event) &&
      visibleTeamIds.includes(webhook.teamId),
  );
};

vi.mock('@documenso/prisma', () => ({
  prisma: {
    webhook: {
      findMany: async (args: { where: Record<string, unknown> }) => select(args),
      count: async (args: { where: Record<string, unknown> }) => {
        if (countFailure) {
          throw countFailure;
        }

        return select(args).length;
      },
    },
  },
}));

const { getAllWebhooksByEventTrigger, getTeamWebhooksByEventTrigger } = await import(
  './get-all-webhooks-by-event-trigger'
);

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const event = 'DOCUMENT_COMPLETED' as WebhookTriggerEvents;

const teamOneWebhook = {
  id: 'webhook_team_1',
  teamId: 1,
  enabled: true,
  eventTriggers: ['DOCUMENT_COMPLETED'],
};

const teamTwoWebhook = {
  id: 'webhook_team_2',
  teamId: 2,
  enabled: true,
  eventTriggers: ['DOCUMENT_COMPLETED'],
};

describe('getTeamWebhooksByEventTrigger', () => {
  beforeEach(() => {
    webhooks = [teamOneWebhook, teamTwoWebhook];
    countFailure = null;
  });

  it('resolves a team subscription for an author who has left the team', async () => {
    const resolved = await getTeamWebhooksByEventTrigger({ event, teamId: 1 });

    expect(resolved.map((webhook) => webhook.id)).toEqual(['webhook_team_1']);
  });

  it('leaves other teams alone', async () => {
    const resolved = await getTeamWebhooksByEventTrigger({ event, teamId: 1 });

    expect(resolved.map((webhook) => webhook.teamId)).toEqual([1]);
  });

  it('returns nothing for a team that subscribes to a different event', async () => {
    webhooks = [{ ...teamOneWebhook, eventTriggers: ['DOCUMENT_SIGNED'] }];

    await expect(getTeamWebhooksByEventTrigger({ event, teamId: 1 })).resolves.toEqual([]);
  });

  it('ignores a disabled webhook', async () => {
    webhooks = [{ ...teamOneWebhook, enabled: false }];

    await expect(getTeamWebhooksByEventTrigger({ event, teamId: 1 })).resolves.toEqual([]);
  });
});

describe('getAllWebhooksByEventTrigger', () => {
  beforeEach(() => {
    webhooks = [teamOneWebhook, teamTwoWebhook];
    countFailure = null;

    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('resolves the webhooks of a team the user belongs to', async () => {
    const resolved = await getAllWebhooksByEventTrigger({ event, userId: 1, teamId: 1 });

    expect(resolved.map((webhook) => webhook.id)).toEqual(['webhook_team_1']);
  });

  it('refuses a user asking for a team they do not belong to', async () => {
    // User 1 is a member of team 1 only. Team 2 has a webhook on this event and
    // user 1 must not reach it.
    await expect(getAllWebhooksByEventTrigger({ event, userId: 1, teamId: 2 })).resolves.toEqual([]);
  });

  it('resolves nothing for a user who has lost access to the team', async () => {
    await expect(getAllWebhooksByEventTrigger({ event, userId: 9, teamId: 1 })).resolves.toEqual([]);
  });

  it('warns when the membership clause hid webhooks the team holds', async () => {
    await getAllWebhooksByEventTrigger({ event, userId: 9, teamId: 1 });

    expect(console.warn).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    expect(vi.mocked(console.warn).mock.calls[0][0] as string).toMatch(
      /Team 1 has 1 enabled DOCUMENT_COMPLETED webhook\(s\) that user 9 cannot see/,
    );
  });

  it('says nothing when the team has configured no webhooks', async () => {
    // The ordinary case, and the one that would drown the log if an empty
    // result were treated as a fault on its own.
    webhooks = [teamTwoWebhook];

    await expect(getAllWebhooksByEventTrigger({ event, userId: 1, teamId: 1 })).resolves.toEqual([]);

    expect(console.warn).not.toHaveBeenCalled();
  });

  it('says nothing when the team subscribes to other events only', async () => {
    webhooks = [{ ...teamOneWebhook, eventTriggers: ['DOCUMENT_SIGNED'] }];

    await getAllWebhooksByEventTrigger({ event, userId: 1, teamId: 1 });

    expect(console.warn).not.toHaveBeenCalled();
  });

  it('says nothing when the resolution found webhooks', async () => {
    await getAllWebhooksByEventTrigger({ event, userId: 1, teamId: 1 });

    expect(console.warn).not.toHaveBeenCalled();
  });

  it('still returns the empty result when the explanation itself fails', async () => {
    countFailure = new Error('db: connection reset');

    await expect(getAllWebhooksByEventTrigger({ event, userId: 9, teamId: 1 })).resolves.toEqual([]);

    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});
