import signingCelebration from '@documenso/assets/images/signing-celebration.png';
import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { EnvelopeRenderProvider } from '@documenso/lib/client-only/providers/envelope-render-provider';
import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { isRecipientAccess2FASatisfied } from '@documenso/lib/server-only/2fa/email/recipient-access-2fa-cookie';
import { loadRecipientBrandingByTeamId } from '@documenso/lib/server-only/branding/load-recipient-branding';
import { getDocumentAndSenderByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { viewedDocument } from '@documenso/lib/server-only/document/viewed-document';
import { getEnvelopeForRecipientSigning } from '@documenso/lib/server-only/envelope/get-envelope-for-recipient-signing';
import { getEnvelopeRequiredAccessData } from '@documenso/lib/server-only/envelope/get-envelope-required-access-data';
import { getCompletedFieldsForToken } from '@documenso/lib/server-only/field/get-completed-fields-for-token';
import { getFieldsForToken } from '@documenso/lib/server-only/field/get-fields-for-token';
import { getIsRecipientsTurnToSign } from '@documenso/lib/server-only/recipient/get-is-recipient-turn';
import { getNextPendingRecipient } from '@documenso/lib/server-only/recipient/get-next-pending-recipient';
import { getRecipientByToken } from '@documenso/lib/server-only/recipient/get-recipient-by-token';
import { getRecipientSignatures } from '@documenso/lib/server-only/recipient/get-recipient-signatures';
import { getRecipientsForAssistant } from '@documenso/lib/server-only/recipient/get-recipients-for-assistant';
import { getTeamSettings } from '@documenso/lib/server-only/team/get-team-settings';
import { getUserByEmail } from '@documenso/lib/server-only/user/get-user-by-email';
import { DocumentAccessAuth } from '@documenso/lib/types/document-auth';
import { SignatureLevel } from '@documenso/lib/types/signature-level';
import { extractDocumentAuthMethods } from '@documenso/lib/utils/document-auth';
import { logger } from '@documenso/lib/utils/logger';
import { isRecipientExpired } from '@documenso/lib/utils/recipients';
import { prisma } from '@documenso/prisma';
import { SigningCard3D } from '@documenso/ui/components/signing-card';
import { Trans } from '@lingui/react/macro';
import type { Recipient } from '@prisma/client';
import { DocumentSigningOrder, DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';
import { Clock8 } from 'lucide-react';
import { Link, redirect } from 'react-router';
import { getOptionalLoaderContext } from 'server/utils/get-loader-session';
import { match } from 'ts-pattern';

import { Header as AuthenticatedHeader } from '~/components/general/app-header';
import { DocumentSigningAccess2FAGate } from '~/components/general/document-signing/document-signing-access-2fa-gate';
import { DocumentSigningAuthPageView } from '~/components/general/document-signing/document-signing-auth-page';
import { DocumentSigningAuthProvider } from '~/components/general/document-signing/document-signing-auth-provider';
import { DocumentSigningPageViewV1 } from '~/components/general/document-signing/document-signing-page-view-v1';
import { DocumentSigningPageViewV2 } from '~/components/general/document-signing/document-signing-page-view-v2';
import { DocumentSigningProvider } from '~/components/general/document-signing/document-signing-provider';
import { EnvelopeSigningProvider } from '~/components/general/document-signing/envelope-signing-provider';
import { RecipientBranding } from '~/components/general/recipient-branding';
import { useCspNonce } from '~/utils/nonce';
import { superLoaderJson, useSuperLoaderData } from '~/utils/super-json-loader';

import type { Route } from './+types/_index';

const handleV1Loader = async ({ params, request }: Route.LoaderArgs) => {
  const { requestMetadata } = getOptionalLoaderContext();

  const { user } = await getOptionalSession(request);

  const { token } = params;

  if (!token) {
    throw new Response('Not Found', { status: 404 });
  }

  const [document, recipient, fields, completedFields] = await Promise.all([
    getDocumentAndSenderByToken({
      token,
      userId: user?.id,
      requireAccessAuth: false,
    }).catch(() => null),
    getRecipientByToken({ token }).catch(() => null),
    getFieldsForToken({ token }),
    getCompletedFieldsForToken({ token }),
  ]);

  if (!document || !document.documentData || !recipient || document.status === DocumentStatus.DRAFT) {
    throw new Response('Not Found', { status: 404 });
  }

  const recipientWithFields = { ...recipient, fields };

  const isRecipientsTurn = await getIsRecipientsTurnToSign({ token });

  if (!isRecipientsTurn) {
    throw redirect(`/sign/${token}/waiting`);
  }

  const allRecipients =
    recipient.role === RecipientRole.ASSISTANT
      ? await getRecipientsForAssistant({
          token,
        })
      : [recipient];

  if (
    document.documentMeta?.signingOrder === DocumentSigningOrder.SEQUENTIAL &&
    recipient.role !== RecipientRole.ASSISTANT
  ) {
    const nextPendingRecipient = await getNextPendingRecipient({
      documentId: document.id,
      currentRecipientId: recipient.id,
    });

    if (nextPendingRecipient) {
      allRecipients.push({
        ...nextPendingRecipient,
        fields: [],
      });
    }
  }

  const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
    documentAuth: document.authOptions,
    recipientAuth: recipient.authOptions,
  });

  const isAccessAuthValid = derivedRecipientAccessAuth.every((accesssAuth) =>
    match(accesssAuth)
      .with(DocumentAccessAuth.ACCOUNT, () => user && user.email === recipient.email)
      .with(DocumentAccessAuth.TWO_FACTOR_AUTH, () => true) // Allow without account requirement
      .exhaustive(),
  );

  let recipientHasAccount: boolean | null = null;

  if (!isAccessAuthValid) {
    recipientHasAccount = await getUserByEmail({ email: recipient.email })
      .then((user) => !!user)
      .catch(() => false);

    return {
      isDocumentAccessValid: false,
      isAccess2FARequired: false,
      recipientEmail: recipient.email,
      recipientHasAccount,
    } as const;
  }

  // Withhold the document until the recipient has entered their emailed code.
  const isAccess2FASatisfied = await isRecipientAccess2FASatisfied({
    headers: request.headers,
    documentAuthOptions: document.authOptions,
    recipient,
  });

  if (!isAccess2FASatisfied) {
    return {
      isDocumentAccessValid: false,
      isAccess2FARequired: true,
      documentAuthOptions: document.authOptions,
      recipient: pickGateRecipient(recipient),
    } as const;
  }

  await viewedDocument({
    token,
    requestMetadata,
    recipientAccessAuth: derivedRecipientAccessAuth,
  }).catch(() => null);

  const { documentMeta } = document;

  if (recipient.signingStatus === SigningStatus.REJECTED) {
    throw redirect(`/sign/${token}/rejected`);
  }

  if (isRecipientExpired(recipient)) {
    throw redirect(`/sign/${token}/expired`);
  }

  if (document.status === DocumentStatus.COMPLETED || recipient.signingStatus === SigningStatus.SIGNED) {
    throw redirect(documentMeta?.redirectUrl || `/sign/${token}/complete`);
  }

  const [recipientSignatures, settings] = await Promise.all([
    getRecipientSignatures({ recipientId: recipient.id }),
    getTeamSettings({ teamId: document.teamId }),
  ]);

  const [recipientSignature] = recipientSignatures;

  return {
    isDocumentAccessValid: true,
    document,
    fields,
    recipient,
    recipientWithFields,
    allRecipients,
    completedFields,
    recipientSignature,
    isRecipientsTurn,
    includeSenderDetails: settings.includeSenderDetails,
    branding: {
      brandingEnabled: settings.brandingEnabled,
      brandingLogo: settings.brandingLogo,
    },
  } as const;
};

const handleV2Loader = async ({ params, request }: Route.LoaderArgs) => {
  const { token } = params;

  const { requestMetadata } = getOptionalLoaderContext();

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
          isAccess2FARequired: false,
          ...requiredAccessData,
        } as const;
      }

      throw new Response('Not Found', { status: 404 });
    });

  if (!envelopeForSigning.isDocumentAccessValid) {
    return envelopeForSigning;
  }

  const { envelope, recipient, isCompleted, isRejected, isExpired, isRecipientsTurn } = envelopeForSigning;

  if (!isRecipientsTurn) {
    throw redirect(`/sign/${token}/waiting`);
  }

  const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
    documentAuth: envelope.authOptions,
    recipientAuth: recipient.authOptions,
  });

  const isAccessAuthValid = derivedRecipientAccessAuth.every((accesssAuth) =>
    match(accesssAuth)
      .with(DocumentAccessAuth.ACCOUNT, () => user && user.email === recipient.email)
      .with(DocumentAccessAuth.TWO_FACTOR_AUTH, () => true) // Allow without account requirement
      .exhaustive(),
  );

  let recipientHasAccount: boolean | null = null;

  if (!isAccessAuthValid) {
    recipientHasAccount = await getUserByEmail({ email: recipient.email })
      .then((user) => !!user)
      .catch(() => false);

    return {
      isDocumentAccessValid: false,
      isAccess2FARequired: false,
      recipientEmail: recipient.email,
      recipientHasAccount,
    } as const;
  }

  // Withhold the document until the recipient has entered their emailed code.
  const isAccess2FASatisfied = await isRecipientAccess2FASatisfied({
    headers: request.headers,
    documentAuthOptions: envelope.authOptions,
    recipient,
  });

  if (!isAccess2FASatisfied) {
    return {
      isDocumentAccessValid: false,
      isAccess2FARequired: true,
      documentAuthOptions: envelope.authOptions,
      recipient: pickGateRecipient(recipient),
    } as const;
  }

  if (isRejected) {
    throw redirect(`/sign/${token}/rejected`);
  }

  if (isCompleted) {
    throw redirect(envelope.documentMeta.redirectUrl || `/sign/${token}/complete`);
  }

  if (isExpired) {
    throw redirect(`/sign/${token}/expired`);
  }

  // Only SES envelopes can be signed. Remote signing through a trust service
  // provider has been removed, so an AES or QES envelope is refused rather
  // than shown with a signing flow that could never complete it.
  if (envelope.signatureLevel !== SignatureLevel.SES) {
    logger.error({
      msg: 'Refusing to open an envelope that is not SES for signing',
      envelopeId: envelope.id,
      signatureLevel: envelope.signatureLevel,
    });

    throw new AppError(AppErrorCode.CSC_INSTANCE_MODE_MISMATCH, {
      message: `Envelope ${envelope.id} has signature level ${envelope.signatureLevel}, which this instance cannot sign.`,
    });
  }

  await viewedDocument({
    token,
    requestMetadata,
    recipientAccessAuth: derivedRecipientAccessAuth,
  }).catch(() => null);

  return {
    isDocumentAccessValid: true,
    envelopeForSigning,
  } as const;
};

/**
 * Only what the access code gate needs, so nothing of the document leaves the
 * server before the code is entered.
 */
const pickGateRecipient = (recipient: Pick<Recipient, 'id' | 'token' | 'email' | 'name' | 'role' | 'authOptions'>) => ({
  id: recipient.id,
  token: recipient.token,
  email: recipient.email,
  name: recipient.name,
  role: recipient.role,
  authOptions: recipient.authOptions,
});

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
          teamId: true,
        },
      },
    },
  });

  if (!foundRecipient) {
    throw new Response('Not Found', { status: 404 });
  }

  const branding = await loadRecipientBrandingByTeamId({
    teamId: foundRecipient.envelope.teamId,
  });

  if (foundRecipient.envelope.internalVersion === 2) {
    const payloadV2 = await handleV2Loader(loaderArgs);

    return superLoaderJson({
      version: 2,
      payload: payloadV2,
      branding,
    } as const);
  }

  const payloadV1 = await handleV1Loader(loaderArgs);

  return superLoaderJson({
    version: 1,
    payload: payloadV1,
    branding,
  } as const);
}

export default function SigningPage() {
  const data = useSuperLoaderData<typeof loader>();
  const cspNonce = useCspNonce();

  return (
    <>
      <RecipientBranding branding={data.branding} cspNonce={cspNonce} />
      {data.version === 2 ? <SigningPageV2 data={data.payload} /> : <SigningPageV1 data={data.payload} />}
    </>
  );
}

const SigningPageV1 = ({ data }: { data: Awaited<ReturnType<typeof handleV1Loader>> }) => {
  const { sessionData } = useOptionalSession();

  const user = sessionData?.user;

  if (!data.isDocumentAccessValid) {
    if (data.isAccess2FARequired) {
      return <DocumentSigningAccess2FAGate documentAuthOptions={data.documentAuthOptions} recipient={data.recipient} />;
    }

    return <DocumentSigningAuthPageView email={data.recipientEmail} emailHasAccount={!!data.recipientHasAccount} />;
  }

  const {
    document,
    fields,
    recipient,
    completedFields,
    recipientSignature,
    isRecipientsTurn,
    allRecipients,
    includeSenderDetails,
    branding,
    recipientWithFields,
  } = data;

  if (document.deletedAt || document.status === DocumentStatus.REJECTED) {
    return (
      <div className="-mx-4 flex max-w-[100vw] flex-col items-center overflow-x-hidden px-4 pt-16 md:-mx-8 md:px-8 lg:pt-16 xl:pt-24">
        <SigningCard3D
          name={recipient.name}
          signature={recipientSignature}
          signingCelebrationImage={signingCelebration}
        />

        <div className="relative mt-2 flex w-full flex-col items-center">
          <div className="mt-8 flex items-center text-center text-red-600">
            <Clock8 className="mr-2 h-5 w-5" />
            <span className="text-sm">
              <Trans>Document Cancelled</Trans>
            </span>
          </div>

          <h2 className="mt-6 max-w-[35ch] text-center font-semibold text-2xl leading-normal md:text-3xl lg:text-4xl">
            <Trans>
              <span className="mt-1.5 block">"{document.title}"</span> is no longer available to sign
            </Trans>
          </h2>

          <p className="mt-2.5 max-w-[60ch] text-center font-medium text-muted-foreground text-sm md:text-base">
            <Trans>This document has been cancelled by the owner.</Trans>
          </p>

          {user && (
            <Link to="/" className="mt-36 text-documenso-700 hover:text-documenso-600">
              <Trans>Go Back Home</Trans>
            </Link>
          )}
        </div>
      </div>
    );
  }

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
        {sessionData?.user && <AuthenticatedHeader />}

        <div className="mt-8 mb-8 px-4 md:mt-12 md:mb-12 md:px-8">
          <DocumentSigningPageViewV1
            recipient={recipientWithFields}
            document={document}
            fields={fields}
            completedFields={completedFields}
            isRecipientsTurn={isRecipientsTurn}
            allRecipients={allRecipients}
            includeSenderDetails={includeSenderDetails}
            branding={branding}
          />
        </div>
      </DocumentSigningAuthProvider>
    </DocumentSigningProvider>
  );
};

const SigningPageV2 = ({ data }: { data: Awaited<ReturnType<typeof handleV2Loader>> }) => {
  const { sessionData } = useOptionalSession();
  const user = sessionData?.user;

  if (!data.isDocumentAccessValid) {
    if (data.isAccess2FARequired) {
      return <DocumentSigningAccess2FAGate documentAuthOptions={data.documentAuthOptions} recipient={data.recipient} />;
    }

    return <DocumentSigningAuthPageView email={data.recipientEmail} emailHasAccount={!!data.recipientHasAccount} />;
  }

  const { envelope, recipientSignature, recipient } = data.envelopeForSigning;

  if (envelope.deletedAt || envelope.status === DocumentStatus.REJECTED) {
    return (
      <div className="-mx-4 flex max-w-[100vw] flex-col items-center overflow-x-hidden px-4 pt-16 md:-mx-8 md:px-8 lg:pt-16 xl:pt-24">
        <SigningCard3D
          name={recipient.name}
          signature={recipientSignature || undefined}
          signingCelebrationImage={signingCelebration}
        />

        <div className="relative mt-2 flex w-full flex-col items-center">
          <div className="mt-8 flex items-center text-center text-red-600">
            <Clock8 className="mr-2 h-5 w-5" />
            <span className="text-sm">
              <Trans>Document Cancelled</Trans>
            </span>
          </div>

          <h2 className="mt-6 max-w-[35ch] text-center font-semibold text-2xl leading-normal md:text-3xl lg:text-4xl">
            <Trans>
              <span className="mt-1.5 block">"{envelope.title}"</span> is no longer available to sign
            </Trans>
          </h2>

          <p className="mt-2.5 max-w-[60ch] text-center font-medium text-muted-foreground text-sm md:text-base">
            <Trans>This document has been cancelled by the owner.</Trans>
          </p>

          {user && (
            <Link to="/" className="mt-36 text-documenso-700 hover:text-documenso-600">
              <Trans>Go Back Home</Trans>
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <EnvelopeSigningProvider
      envelopeData={data.envelopeForSigning}
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
          token={recipient.token}
        >
          <DocumentSigningPageViewV2 />
        </EnvelopeRenderProvider>
      </DocumentSigningAuthProvider>
    </EnvelopeSigningProvider>
  );
};
