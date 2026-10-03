import type { WebhookTriggerEvents } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every caller of this runs it inside `io.runTask`, which writes a completion
 * marker the moment the callback resolves and never runs the step again. What
 * matters here is therefore not how many deliveries were queued but whether the
 * function resolves when none of them were, because resolving is what turns a
 * dead integration into a step the retry skips for good.
 */

const triggerJob = vi.fn();

const getAllWebhooksByEventTrigger = vi.fn();

const getTeamWebhooksByEventTrigger = vi.fn();

vi.mock('../../../jobs/client', () => ({
  jobs: {
    triggerJob: async (...args: unknown[]) => await triggerJob(...args),
  },
}));

vi.mock('../get-all-webhooks-by-event-trigger', () => ({
  getAllWebhooksByEventTrigger: async (...args: unknown[]) => await getAllWebhooksByEventTrigger(...args),
  getTeamWebhooksByEventTrigger: async (...args: unknown[]) => await getTeamWebhooksByEventTrigger(...args),
}));

const { triggerTeamWebhook, triggerWebhook } = await import('./trigger-webhook');

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const event = 'DOCUMENT_COMPLETED' as WebhookTriggerEvents;

const call = async () =>
  await triggerWebhook({
    event,
    data: { id: 'envelope_abc123' },
    userId: 1,
    teamId: 2,
  });

describe('triggerWebhook', () => {
  beforeEach(() => {
    triggerJob.mockReset();
    triggerJob.mockResolvedValue(undefined);
    getAllWebhooksByEventTrigger.mockReset();
    getAllWebhooksByEventTrigger.mockResolvedValue([{ id: 'webhook_1' }, { id: 'webhook_2' }]);
    getTeamWebhooksByEventTrigger.mockReset();
    getTeamWebhooksByEventTrigger.mockResolvedValue([{ id: 'webhook_1' }, { id: 'webhook_2' }]);

    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('queues one delivery per registered webhook', async () => {
    await call();

    expect(triggerJob).toHaveBeenCalledTimes(2);
    expect(triggerJob.mock.calls.map(([options]) => options.payload.webhookId)).toEqual(['webhook_1', 'webhook_2']);
  });

  it('does nothing when nothing is registered for the event', async () => {
    getAllWebhooksByEventTrigger.mockResolvedValue([]);

    await expect(call()).resolves.toBeUndefined();

    expect(triggerJob).not.toHaveBeenCalled();
  });

  it('fails when every delivery fails to queue', async () => {
    triggerJob.mockRejectedValue(new Error('redis: connection refused'));

    await expect(call()).rejects.toThrow(/Failed to queue 2 of 2/);
  });

  it('fails when one delivery of several fails to queue', async () => {
    // The surrounding runTask marker would otherwise record the whole fan-out
    // as done, and the one partner that was never told stays never told.
    triggerJob.mockImplementation(async (options: { payload: { webhookId: string } }) => {
      if (options.payload.webhookId === 'webhook_2') {
        throw new Error('redis: connection refused');
      }
    });

    await expect(call()).rejects.toThrow(/Failed to queue 1 of 2/);
  });

  it('keeps the underlying reason as the cause', async () => {
    const reason = new Error('redis: connection refused');

    triggerJob.mockRejectedValue(reason);

    const error = await call().catch((thrown: Error) => thrown);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    expect((error as Error).cause).toBe(reason);
  });

  it('fails when the registered webhooks cannot be read', async () => {
    getAllWebhooksByEventTrigger.mockRejectedValue(new Error('db: connection reset'));

    await expect(call()).rejects.toThrow(/Failed to read the webhooks registered for DOCUMENT_COMPLETED/);
  });
});

describe('triggerTeamWebhook', () => {
  beforeEach(() => {
    triggerJob.mockReset();
    triggerJob.mockResolvedValue(undefined);
    getAllWebhooksByEventTrigger.mockReset();
    getTeamWebhooksByEventTrigger.mockReset();
    getTeamWebhooksByEventTrigger.mockResolvedValue([{ id: 'webhook_1' }]);

    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  const callForTeam = async () =>
    await triggerTeamWebhook({
      event,
      data: { id: 'envelope_abc123' },
      teamId: 2,
    });

  it('resolves by team and never by membership', async () => {
    // The whole point of the second entry point. A job that reached for the
    // scoped resolver would pass the author's id, and the author is exactly the
    // person whose access may have lapsed.
    await callForTeam();

    expect(getTeamWebhooksByEventTrigger).toHaveBeenCalledWith({ event, teamId: 2 });
    expect(getAllWebhooksByEventTrigger).not.toHaveBeenCalled();
  });

  it('queues one delivery per webhook the team holds', async () => {
    getTeamWebhooksByEventTrigger.mockResolvedValue([{ id: 'webhook_1' }, { id: 'webhook_2' }]);

    await callForTeam();

    expect(triggerJob.mock.calls.map(([options]) => options.payload.webhookId)).toEqual(['webhook_1', 'webhook_2']);
  });

  it('fails when a delivery cannot be queued', async () => {
    triggerJob.mockRejectedValue(new Error('redis: connection refused'));

    await expect(callForTeam()).rejects.toThrow(/Failed to queue 1 of 1/);
  });

  it('fails when the team webhooks cannot be read', async () => {
    getTeamWebhooksByEventTrigger.mockRejectedValue(new Error('db: connection reset'));

    await expect(callForTeam()).rejects.toThrow(/Failed to read the webhooks registered for DOCUMENT_COMPLETED/);
  });

  it('does nothing when the team subscribes to nothing', async () => {
    getTeamWebhooksByEventTrigger.mockResolvedValue([]);

    await expect(callForTeam()).resolves.toBeUndefined();

    expect(triggerJob).not.toHaveBeenCalled();
  });
});
