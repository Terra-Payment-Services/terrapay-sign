import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { EnvelopeRenderProvider } from '@documenso/lib/client-only/providers/envelope-render-provider';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { isRecipientAccess2FASatisfied } from '@documenso/lib/server-only/2fa/email/recipient-access-2fa-cookie';
import { captureServerEvent } from '@documenso/lib/server-only/analytics/capture-server-event';
import { getDocumentAndSenderByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { viewedDocument } from '@documenso/lib/server-only/document/viewed-document';
import { getEnvelopeForRecipientSigning } from '@documenso/lib/server-only/envelope/get-envelope-for-recipient-signing';
import { getEnvelopeRequiredAccessData } from '@documenso/lib/server-only/envelope/get-envelope-required-access-data';
import { getCompletedFieldsForToken } from '@documenso/lib/server-only/field/get-completed-fields-for-token';
import { getFieldsForToken } from '@documenso/lib/server-only/field/get-fields-for-token';
import { getOrganisationClaimByTeamId } from '@documenso/lib/server-only/organisation/get-organisation-claims';
import { getIsRecipientsTurnToSign } from '@documenso/lib/server-only/recipient/get-is-recipient-turn';
import { getRecipientByToken } from '@documenso/lib/server-only/recipient/get-recipient-by-token';
import { getRecipientsForAssistant } from '@documenso/lib/server-only/recipient/get-recipients-for-assistant';
import { DocumentAccessAuth } from '@documenso/lib/types/document-auth';
import { fireAndForget } from '@documenso/lib/universal/fire-and-forget';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { extractDocumentAuthMethods } from '@documenso/lib/utils/document-auth';
import { isRecipientExpired } from '@documenso/lib/utils/recipients';
import { prisma } from '@documenso/prisma';
import type { Envelope, Recipient } from '@prisma/client';
import { RecipientRole } from '@prisma/client';
import { data } from 'react-router';
import { match } from 'ts-pattern';

import { EmbedSignDocumentV1ClientPage } from '~/components/embed/embed-document-signing-page-v1';
import { EmbedSignDocumentV2ClientPage } from '~/components/embed/embed-document-signing-page-v2';
import { DocumentSigningAuthProvider } from '~/components/general/document-signing/document-signing-auth-provider';
import { DocumentSigningProvider } from '~/components/general/document-signing/document-signing-provider';
import { EnvelopeSigningProvider } from '~/components/general/document-signing/envelope-signing-provider';
import { superLoaderJson, useSuperLoaderData } from '~/utils/super-json-loader';

import { getOptionalLoaderContext } from '../../../../server/utils/get-loader-session';
import type { Route } from './+types/sign.$token';

/**
 * Withhold the document until the recipient has entered their emailed access
 * code. The layout's error boundary renders the code form.
 */
const assertEmbedAccess2FASatisfied = async ({
  request,
  documentAuthOptions,
  recipient,
}: {
  request: Request;
  documentAuthOptions: Envelope['authOptions'];
  recipient: Pick<Recipient, 'id' | 'token' | 'email' | 'name' | 'role' | 'authOptions'>;
}) => {
  const isSatisfied = await isRecipientAccess2FASatisfied({
    headers: request.headers,
    documentAuthOptions,
    recipient,
  });

  if (isSatisfied) {
    return;
  }

  throw data(
    {
      type: 'embed-access-code-required',
      documentAuthOptions,
      recipient: {
        id: recipient.id,
        token: recipient.token,
        email: recipient.email,
        name: recipient.name,
        role: recipient.role,
        authOptions: recipient.authOptions,
      },
    },
    {
      status: 401,
    },
  );
};

async function handleV1Loader({ params, request }: Route.LoaderArgs) {
  const { requestMetadata } = getOptionalLoaderContext();

  if (!params.token) {
    throw new Response('Not found', { status: 404 });
  }

  const token = params.token;

  const { user } = await getOptionalSession(request);

  const [document, fields, recipient, completedFields] = await Promise.all([
    getDocumentAndSenderByToken({
      token,
      userId: user?.id,
      requireAccessAuth: false,
    }).catch(() => null),
    getFieldsForToken({ token }),
    getRecipientByToken({ token }).catch(() => null),
    getCompletedFieldsForToken({ token }).catch(() => []),
  ]);

  // `document.directLink` is always available but we're doing this to
  // satisfy the type checker.
  if (!document || !recipient) {
    throw new Response('Not found', { status: 404 });
  }

  const organisationClaim = await getOrganisationClaimByTeamId({ teamId: document.teamId });

  const allowEmbedSigningWhitelabel = organisationClaim.flags.embedSigningWhiteLabel;
  const hidePoweredBy = organisationClaim.flags.hidePoweredBy;

  if (isRecipientExpired(recipient)) {
    throw data(
      {
        type: 'embed-recipient-expired',
      },
      {
        status: 403,
      },
    );
  }

  const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
    documentAuth: document.authOptions,
  });

  const isAccessAuthValid = derivedRecipientAccessAuth.every((accesssAuth) =>
    match(accesssAuth)
      .with(DocumentAccessAuth.ACCOUNT, () => user && user.email === recipient.email)
      .with(DocumentAccessAuth.TWO_FACTOR_AUTH, () => true) // Allow without account requirement
      .exhaustive(),
  );

  if (!isAccessAuthValid) {
    throw data(
      {
        type: 'embed-authentication-required',
        email: user?.email || recipient.email,
        returnTo: `/embed/sign/${token}`,
      },
      {
        status: 401,
      },
    );
  }

  await assertEmbedAccess2FASatisfied({ request, documentAuthOptions: document.authOptions, recipient });

  const isRecipientsTurnToSign = await getIsRecipientsTurnToSign({ token });

  if (!isRecipientsTurnToSign) {
    throw data(
      {
        type: 'embed-waiting-for-turn',
      },
      {
        status: 403,
      },
    );
  }

  await viewedDocument({
    token,
    requestMetadata,
    recipientAccessAuth: derivedRecipientAccessAuth,
  });

  const allRecipients =
    recipient.role === RecipientRole.ASSISTANT
      ? await getRecipientsForAssistant({
          token,
        })
      : [];

  fireAndForget(async () => {
    const team = await prisma.team.findFirst({
      where: {
        id: document.teamId,
      },
      select: {
        organisationId: true,
      },
    });

    captureServerEvent({
      event: 'App: Embed Session Started',
      userId: user?.id,
      organisationId: team?.organisationId,
      teamId: document.teamId,
      properties: {
        type: 'signing',
        version: 'v0',
        recipientId: recipient.id,
        envelopeId: document.envelopeId,
      },
    });
  });

  return {
    token,
    user,
    document,
    allRecipients,
    recipient,
    fields,
    completedFields,
    hidePoweredBy,
    allowEmbedSigningWhitelabel,
  };
}

async function handleV2Loader({ params, request }: Route.LoaderArgs) {
  const { requestMetadata } = getOptionalLoaderContext();

  if (!params.token) {
    throw new Response('Not found', { status: 404 });
  }

  const token = params.token;

  const { user } = await getOptionalSession(request);

  const envelopeForSigning = await getEnvelopeForRecipientSigning({
    token,
    userId: user?.id,
  })
    .then((envelopeForSigning) => {
      return {
        isDocumentAccessValid: true,
        ...envelopeForSigning,
      } as const;
    })
    .catch(async (e) => {
      const error = AppError.parseError(e);

      if (error.code === AppErrorCode.UNAUTHORIZED) {
        const requiredAccessData = await getEnvelopeRequiredAccessData({ token });

        return {
          isDocumentAccessValid: false,
          ...requiredAccessData,
        } as const;
      }

      throw new Response('Not Found', { status: 404 });
    });

  if (!envelopeForSigning.isDocumentAccessValid) {
    throw data(
      {
        type: 'embed-authentication-required',
        email: envelopeForSigning.recipientEmail,
        returnTo: `/embed/sign/${token}`,
      },
      {
        status: 401,
      },
    );
  }

  const { envelope, recipient, isRecipientsTurn, isExpired } = envelopeForSigning;

  const organisationClaim = await getOrganisationClaimByTeamId({ teamId: envelope.teamId });

  const allowEmbedSigningWhitelabel = organisationClaim.flags.embedSigningWhiteLabel;
  const hidePoweredBy = organisationClaim.flags.hidePoweredBy;

  if (isExpired) {
    throw data(
      {
        type: 'embed-recipient-expired',
      },
      {
        status: 403,
      },
    );
  }

  if (!isRecipientsTurn) {
    throw data(
      {
        type: 'embed-waiting-for-turn',
      },
      {
        status: 403,
      },
    );
  }

  const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
    documentAuth: envelope.authOptions,
    recipientAuth: recipient.authOptions,
  });

  const isAccessAuthValid = derivedRecipientAccessAuth.every((accesssAuth) =>
    match(accesssAuth)
      .with(DocumentAccessAuth.ACCOUNT, () => user && user.email === recipient.email)
      .with(DocumentAccessAuth.TWO_FACTOR_AUTH, () => true)
      .exhaustive(),
  );

  if (!isAccessAuthValid) {
    throw data(
      {
        type: 'embed-authentication-required',
        email: user?.email || recipient.email,
        returnTo: `/embed/sign/${token}`,
      },
      {
        status: 401,
      },
    );
  }

  await assertEmbedAccess2FASatisfied({ request, documentAuthOptions: envelope.authOptions, recipient });

  await viewedDocument({
    token,
    requestMetadata,
    recipientAccessAuth: derivedRecipientAccessAuth,
  }).catch(() => null);

  fireAndForget(async () => {
    const team = await prisma.team.findFirst({
      where: {
        id: envelope.teamId,
      },
      select: {
        organisationId: true,
      },
    });

    captureServerEvent({
      event: 'App: Embed Session Started',
      userId: user?.id,
      organisationId: team?.organisationId,
      teamId: envelope.teamId,
      properties: {
        type: 'signing',
        version: 'v0',
        recipientId: recipient.id,
        envelopeId: envelope.id,
      },
    });
  });

  return {
    token,
    user,
    envelopeForSigning,
    hidePoweredBy,
    allowEmbedSigningWhitelabel,
  };
}

export async function loader(loaderArgs: Route.LoaderArgs) {
  const { token } = loaderArgs.params;

  if (!token) {
    throw new Response('Not Found', { status: 404 });
  }

  // Not efficient but works for now until we remove v1.
  const foundRecipient = await prisma.recipient.findFirst({
    where: {
      token,
    },
    select: {
      envelope: {
        select: {
          internalVersion: true,
        },
      },
    },
  });

  if (!foundRecipient) {
    throw new Response('Not Found', { status: 404 });
  }

  if (foundRecipient.envelope.internalVersion === 2) {
    const payloadV2 = await handleV2Loader(loaderArgs);

    return superLoaderJson({
      version: 2,
      payload: payloadV2,
    } as const);
  }

  const payloadV1 = await handleV1Loader(loaderArgs);

  return superLoaderJson({
    version: 1,
    payload: payloadV1,
  } as const);
}

export default function EmbedSignDocumentPage() {
  const { version, payload } = useSuperLoaderData<typeof loader>();

  if (version === 1) {
    return <EmbedSignDocumentPageV1 data={payload} />;
  }

  return <EmbedSignDocumentPageV2 data={payload} />;
}

const EmbedSignDocumentPageV1 = ({ data }: { data: Awaited<ReturnType<typeof handleV1Loader>> }) => {
  const {
    token,
    user,
    document,
    allRecipients,
    recipient,
    fields,
    completedFields,
    hidePoweredBy,
    allowEmbedSigningWhitelabel,
  } = data;

  return (
    <DocumentSigningProvider
      email={recipient.email}
      fullName={user?.email === recipient.email ? user?.name : recipient.name}
      signature={user?.email === recipient.email ? user?.signature : undefined}
      typedSignatureEnabled={document.documentMeta?.typedSignatureEnabled}
      uploadSignatureEnabled={document.documentMeta?.uploadSignatureEnabled}
      drawSignatureEnabled={document.documentMeta?.drawSignatureEnabled}
    >
      <DocumentSigningAuthProvider
        documentAuthOptions={document.authOptions}
        recipient={recipient}
        user={user}
        isAccess2FAVerified
      >
        <EmbedSignDocumentV1ClientPage
          token={token}
          documentId={document.id}
          envelopeId={document.envelopeId}
          envelopeItems={document.envelopeItems}
          recipient={recipient}
          fields={fields}
          completedFields={completedFields}
          metadata={document.documentMeta}
          isCompleted={isDocumentCompleted(document.status)}
          hidePoweredBy={hidePoweredBy}
          allowWhitelabelling={allowEmbedSigningWhitelabel}
          allRecipients={allRecipients}
        />
      </DocumentSigningAuthProvider>
    </DocumentSigningProvider>
  );
};

const EmbedSignDocumentPageV2 = ({ data }: { data: Awaited<ReturnType<typeof handleV2Loader>> }) => {
  const { token, user, envelopeForSigning, hidePoweredBy, allowEmbedSigningWhitelabel } = data;

  const { envelope, recipient } = envelopeForSigning;

  return (
    <EnvelopeSigningProvider
      envelopeData={envelopeForSigning}
      email={recipient.email}
      fullName={user?.email === recipient.email ? user?.name : recipient.name}
      signature={user?.email === recipient.email ? user?.signature : undefined}
    >
      <DocumentSigningAuthProvider
        documentAuthOptions={envelope.authOptions}
        recipient={recipient}
        user={user}
        isAccess2FAVerified
      >
        <EnvelopeRenderProvider
          version="current"
          envelope={envelope}
          envelopeItems={envelope.envelopeItems}
          token={token}
        >
          <EmbedSignDocumentV2ClientPage
            hidePoweredBy={hidePoweredBy}
            allowWhitelabelling={allowEmbedSigningWhitelabel}
          />
        </EnvelopeRenderProvider>
      </DocumentSigningAuthProvider>
    </EnvelopeSigningProvider>
  );
};
