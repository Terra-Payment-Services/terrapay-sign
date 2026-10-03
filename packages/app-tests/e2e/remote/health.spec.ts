import { expect, test } from '@playwright/test';

/**
 * Health of a deployed instance, read through its own endpoint.
 *
 * These specs run on the local path and against a remote origin, so they pull
 * nothing out of the workspace and write nothing. Every request here is a GET.
 */

test('[REMOTE] the health endpoint answers and its database check passes', async ({ request }) => {
  const response = await request.get('/api/health');

  expect(response.status()).toBe(200);

  const body = await response.json();

  expect(body.checks.database.status).toBe('ok');
  expect(body.status).not.toBe('error');
  expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
});

test('[REMOTE] the signing certificate is loaded', async ({ request }) => {
  // /api/health answers 200 on a warning, and a missing certificate is a
  // warning, so the load balancer will call an instance healthy that cannot
  // seal a single document. This is the assertion the load balancer cannot
  // make.
  const response = await request.get('/api/health');

  const body = await response.json();

  expect(body.checks.certificate.status).toBe('ok');
});

test('[REMOTE] the jobs backend can run scheduled work', async ({ request }, testInfo) => {
  // Deployment only, and the reason is not squeamishness about a red test.
  // A deployed instance must run the BullMQ provider against a reachable
  // Redis, because sealing, reminders and expiry are cron jobs and without
  // them the application accepts signatures it never seals. The local suite
  // runs the `local` provider, which executes a job inline the moment it is
  // triggered, and 385 of these specs depend on that: switching the local run
  // to BullMQ to satisfy this one assertion was measured and fails them.
  //
  // So the assertion is right and its scope was wrong. Everything else in this
  // file holds its shape in both places and still runs in both.
  // Keyed on E2E_BASE_URL rather than the project name. The remote project is
  // appended to the local list so these specs run on every local pass, which
  // means it carries the name `remote` in both modes and the name says nothing
  // about where the run is pointed. E2E_BASE_URL is the thing that does.
  testInfo.skip(
    !process.env.E2E_BASE_URL,
    'the local suite runs the inline jobs provider on purpose; this asserts a deployed instance',
  );

  const response = await request.get('/api/health');

  const body = await response.json();

  expect(body.checks.jobs.status).toBe('ok');
});

test('[REMOTE] the certificate status endpoint reports the certificate as available', async ({ request }) => {
  const response = await request.get('/api/certificate-status');

  expect(response.status()).toBe(200);

  const body = await response.json();

  expect(body.isAvailable).toBe(true);
});

test('[REMOTE] the health endpoint reports statuses without internal detail', async ({ request }) => {
  // It is unauthenticated, and the detail text carried raw Redis and
  // SharePoint errors and the upstream watch's advisory count.
  const response = await request.get('/api/health');

  const body = await response.json();

  for (const [name, check] of Object.entries(body.checks as Record<string, Record<string, unknown>>)) {
    expect(Object.keys(check), name).not.toContain('detail');
    expect(typeof check.status, name).toBe('string');
  }
});
