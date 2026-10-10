import fs from 'node:fs';
import path from 'node:path';
import { seedBlankDocument } from '@documenso/prisma/seed/documents';
import { seedBlankTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { apiSignin } from './authentication';

const examplePdfBuffer = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

export type TEnvelopeEditorSurface = {
  root: Page;
  isEmbedded: boolean;
  envelopeId?: string;
  envelopeType: TEnvelopeEditorType;
  userId: number;
  userEmail: string;
  userName: string;
  teamId: number;
};

export type TEnvelopeEditorType = 'DOCUMENT' | 'TEMPLATE';

export const openDocumentEnvelopeEditor = async (page: Page): Promise<TEnvelopeEditorSurface> => {
  const { user, team } = await seedUser();

  const document = await seedBlankDocument(user, team.id, {
    internalVersion: 2,
  });

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/t/${team.url}/documents/${document.id}/edit?step=uploadAndRecipients`,
  });

  return {
    root: page,
    isEmbedded: false,
    envelopeId: document.id,
    envelopeType: 'DOCUMENT',
    userId: user.id,
    userEmail: user.email,
    userName: user.name ?? '',
    teamId: team.id,
  };
};

export const openTemplateEnvelopeEditor = async (page: Page): Promise<TEnvelopeEditorSurface> => {
  const { user, team } = await seedUser();

  const template = await seedBlankTemplate(user, team.id, {
    createTemplateOptions: {
      title: `E2E Template ${Date.now()}`,
      userId: user.id,
      teamId: team.id,
      internalVersion: 2,
    },
  });

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/t/${team.url}/templates/${template.id}/edit?step=uploadAndRecipients`,
  });

  return {
    root: page,
    isEmbedded: false,
    envelopeId: template.id,
    envelopeType: 'TEMPLATE',
    userId: user.id,
    userEmail: user.email,
    userName: user.name ?? '',
    teamId: team.id,
  };
};

export const getEnvelopeEditorSettingsTrigger = (root: Page) => root.locator('button[title="Settings"]');

export const getEnvelopeItemTitleInputs = (root: Page) => root.locator('[data-testid^="envelope-item-title-input-"]');

export const getEnvelopeItemDragHandles = (root: Page) => root.locator('[data-testid^="envelope-item-drag-handle-"]');

export const getEnvelopeItemRemoveButtons = (root: Page) =>
  root.locator('[data-testid^="envelope-item-remove-button-"]');

export const getEnvelopeItemReplaceButtons = (root: Page) =>
  root.locator('[data-testid^="envelope-item-replace-button-"]');

export const getEnvelopeItemDropzoneInput = (root: Page) =>
  root.locator('[data-testid="envelope-item-dropzone"] input[type="file"]');

export const addEnvelopeItemPdf = async (root: Page, fileName = 'embedded-envelope-item.pdf') => {
  await getEnvelopeItemDropzoneInput(root).setInputFiles({
    name: fileName,
    mimeType: 'application/pdf',
    buffer: examplePdfBuffer,
  });
};

export const getRecipientEmailInputs = (root: Page) => root.locator('[data-testid="signer-email-input"]');

export const getRecipientNameInputs = (root: Page) => root.locator('input[placeholder^="Recipient "]');

export const getRecipientRows = (root: Page) =>
  root.locator('[data-testid="signer-email-input"]').locator('xpath=ancestor::fieldset[1]');

export const getRecipientRemoveButtons = (root: Page) => root.locator('[data-testid="remove-signer-button"]');

export const getSigningOrderInputs = (root: Page) => root.locator('[data-testid="signing-order-input"]');

export const clickEnvelopeEditorStep = async (root: Page, stepId: 'upload' | 'addFields' | 'preview') => {
  await root.waitForTimeout(200);
  await root.locator(`[data-testid="envelope-editor-step-${stepId}"]`).first().click();
};

export const clickAddMyselfButton = async (root: Page) => {
  await root.getByRole('button', { name: 'Add Myself' }).click();
};

export const clickAddSignerButton = async (root: Page) => {
  await root.getByRole('button', { name: 'Add Signer' }).click();
};

export const setRecipientEmail = async (root: Page, index: number, email: string) => {
  await getRecipientEmailInputs(root).nth(index).fill(email);
};

export const setRecipientName = async (root: Page, index: number, name: string) => {
  await getRecipientNameInputs(root).nth(index).fill(name);
};

export const setRecipientRole = async (
  root: Page,
  index: number,
  roleLabel: 'Needs to sign' | 'Needs to approve' | 'Needs to view' | 'Receives copy' | 'Can prepare',
) => {
  const row = getRecipientRows(root).nth(index);

  await row.locator('button[role="combobox"]').first().click();
  await root.getByRole('option', { name: roleLabel }).click();
};

export const assertRecipientRole = async (
  root: Page,
  index: number,
  roleLabel: 'Needs to sign' | 'Needs to approve' | 'Needs to view' | 'Receives copy' | 'Can prepare',
) => {
  const row = getRecipientRows(root).nth(index);
  const roleValueByLabel: Record<typeof roleLabel, string> = {
    'Needs to sign': 'SIGNER',
    'Needs to approve': 'APPROVER',
    'Needs to view': 'VIEWER',
    'Receives copy': 'CC',
    'Can prepare': 'ASSISTANT',
  };

  await expect(row.locator('button[role="combobox"]').first()).toHaveAttribute('title', roleValueByLabel[roleLabel]);
};

export const toggleSigningOrder = async (root: Page, enabled: boolean) => {
  const checkbox = root.locator('#signingOrder');
  const currentState = await checkbox.getAttribute('aria-checked');
  const isEnabled = currentState === 'true';

  if (isEnabled !== enabled) {
    await checkbox.click();
  }
};

export const toggleAllowDictateSigners = async (root: Page, enabled: boolean) => {
  const checkbox = root.locator('#allowDictateNextSigner');
  const currentState = await checkbox.getAttribute('aria-checked');
  const isEnabled = currentState === 'true';

  if (isEnabled !== enabled) {
    await checkbox.click();
  }
};

export const setSigningOrderValue = async (root: Page, index: number, value: number) => {
  const input = getSigningOrderInputs(root).nth(index);
  await input.fill(value.toString());
  await input.blur();
};
