import { OrganisationInviteEmailTemplate } from '@documenso/email/templates/organisation-invite';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/organisations';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { prisma } from '@documenso/prisma';
import type { TCreateOrganisationMemberInvitesRequestSchema } from '@documenso/trpc/server/organisation-router/create-organisation-member-invites.types';
import { msg } from '@lingui/core/macro';
import type { Organisation, Prisma } from '@prisma/client';
import { OrganisationMemberInviteStatus } from '@prisma/client';
import { nanoid } from 'nanoid';
import { createElement } from 'react';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { generateDatabaseId } from '../../universal/id';
import { buildOrganisationWhereQuery } from '../../utils/organisations';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import { getEmailContext } from '../email/get-email-context';
import { assertOrganisationRoleAssignable } from './assert-organisation-role-assignable';

export type CreateOrganisationMemberInvitesOptions = {
  userId: number;
  userName: string;
  organisationId: string;
  invitations: TCreateOrganisationMemberInvitesRequestSchema['invitations'];
};

/**
 * Invite organisation members via email to join a organisation.
 */
export const createOrganisationMemberInvites = async ({
  userId,
  userName,
  organisationId,
  invitations,
}: CreateOrganisationMemberInvitesOptions): Promise<void> => {
  const organisation = await prisma.organisation.findFirst({
    where: buildOrganisationWhereQuery({
      organisationId,
      userId,
      roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_ORGANISATION'],
    }),
    include: {
      members: {
        select: {
          user: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      },
      invites: {
        where: {
          status: OrganisationMemberInviteStatus.PENDING,
        },
      },
      organisationGlobalSettings: true,
    },
  });

  if (!organisation) {
    throw new AppError(AppErrorCode.NOT_FOUND);
  }

  const organisationMemberEmails = organisation.members.map((member) => member.user.email);
  const organisationMemberInviteEmails = organisation.invites.map((invite) => invite.email);

  const usersToInvite = invitations.filter((invitation) => {
    // Filter out users that are already members of the organisation.
    if (organisationMemberEmails.includes(invitation.email)) {
      return false;
    }

    // Filter out users that have already been invited to the organisation.
    if (organisationMemberInviteEmails.includes(invitation.email)) {
      return false;
    }

    return true;
  });

  // An invitation is a role grant with a delay on it: the role is fixed here and
  // collected when the invitee accepts, by which time nobody is checking. The
  // shared rule decides, so this path cannot drift away from the member role
  // update.
  await assertOrganisationRoleAssignable({
    organisationId: organisation.id,
    userId,
    roleToAssign: usersToInvite.map(({ organisationRole }) => organisationRole),
  });

  const organisationMemberInvites: Prisma.OrganisationMemberInviteCreateManyInput[] = usersToInvite.map(
    ({ email, organisationRole }) => ({
      id: generateDatabaseId('member_invite'),
      email,
      organisationId,
      organisationRole,
      token: nanoid(32),
    }),
  );

  await prisma.organisationMemberInvite.createMany({
    data: organisationMemberInvites,
  });

  const sendEmailResult = await Promise.allSettled(
    organisationMemberInvites.map(async ({ email, token }) =>
      sendOrganisationMemberInviteEmail({
        email,
        token,
        organisation,
        senderName: userName,
      }),
    ),
  );

  const sendEmailResultErrorList = sendEmailResult.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );

  if (sendEmailResultErrorList.length > 0) {
    console.error(JSON.stringify(sendEmailResultErrorList));

    throw new AppError('EmailDeliveryFailed', {
      message: 'Failed to send invite emails to one or more users.',
      userMessage: `Failed to send invites to ${sendEmailResultErrorList.length}/${organisationMemberInvites.length} users.`,
    });
  }
};

type SendOrganisationMemberInviteEmailOptions = {
  email: string;
  senderName: string;
  token: string;
  organisation: Pick<Organisation, 'id' | 'name'>;
};

/**
 * Send an email to a user inviting them to join a organisation.
 */
export const sendOrganisationMemberInviteEmail = async ({
  email,
  senderName,
  token,
  organisation,
}: SendOrganisationMemberInviteEmailOptions) => {
  const template = createElement(OrganisationInviteEmailTemplate, {
    assetBaseUrl: NEXT_PUBLIC_WEBAPP_URL(),
    baseUrl: NEXT_PUBLIC_WEBAPP_URL(),
    senderName,
    token,
    organisationName: organisation.name,
  });

  const { branding, emailLanguage, senderEmail, emailsDisabled, emailTransport } = await getEmailContext({
    emailType: 'INTERNAL',
    source: {
      type: 'organisation',
      organisationId: organisation.id,
    },
  });

  // Member invites can be sent to anyone, so block them when the organisation has email
  // sending disabled.
  if (emailsDisabled) {
    return;
  }

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template, {
      lang: emailLanguage,
      branding,
    }),
    renderEmailWithI18N(template, {
      lang: emailLanguage,
      branding,
      plainText: true,
    }),
  ]);

  const i18n = await getI18nInstance(emailLanguage);

  await emailTransport.sendMail({
    to: email,
    from: senderEmail,
    subject: i18n._(msg`You have been invited to join ${organisation.name} on TerraPay Sign`),
    html,
    text,
  });
};
