import { AppErrorCode } from '@documenso/lib/errors/app-error';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { match } from 'ts-pattern';

export type ToastMessageDescriptor = {
  title: MessageDescriptor;
  description: MessageDescriptor;
};

export const RECIPIENT_LIMIT_EXCEEDED_ERROR_MESSAGE = {
  title: msg`Too many recipients`,
  description: msg`This document has too many recipients. Please remove some recipients or contact support if you need more.`,
};

export const FAIR_USE_LIMIT_EXCEEDED_ERROR_MESSAGE = {
  title: msg`Fair use limit exceeded`,
  description: msg`Your organisation has reached its plan's fair use limit. Please contact your organisation administrator or support to continue.`,
};

export const PASSWORD_PROTECTED_DOCUMENT_ERROR_MESSAGE = {
  title: msg`Password-protected PDF`,
  description: msg`This PDF needs a password to open. Remove the password and upload it again.`,
};

export const SIGNATURE_ALREADY_INVALID_ERROR_MESSAGE = {
  title: msg`Signature already invalid`,
  description: msg`This PDF's existing signature is already invalid: the file was changed after it was signed. Ask the sender for a copy whose signature still verifies.`,
};

/** Legacy (V1) documents cannot keep a PDF's owner restrictions through sealing. */
export const LEGACY_OWNER_PROTECTED_ERROR_MESSAGE = {
  title: msg`PDF not supported here`,
  description: msg`This PDF restricts editing, which legacy documents cannot keep. Upload it as an envelope instead.`,
};

/** Shown to a direct-template signer, who did not choose the PDF and cannot change it. */
export const DIRECT_TEMPLATE_PDF_RESTRICTED_ERROR_MESSAGE = {
  title: msg`This document cannot be signed here`,
  description: msg`The document's PDF restricts editing, which this signing link cannot handle. Please contact the sender.`,
};

export const DIRECT_TEMPLATE_PASSWORD_PROTECTED_ERROR_MESSAGE = {
  title: msg`This document cannot be signed here`,
  description: msg`The document's PDF is password-protected, which this signing link cannot handle. Please contact the sender.`,
};

/** Sending would rewrite the bytes an existing signature covers, or the PDF cannot be read. */
export const DISTRIBUTE_INVALID_DOCUMENT_FILE_ERROR_MESSAGE = {
  title: msg`Document not sent`,
  description: msg`Preparing this PDF for sending would break the signature it carries, so it was not sent. If it has no signature, the file may be unreadable.`,
};

export const DIRECT_TEMPLATE_SIGNATURE_ALREADY_INVALID_ERROR_MESSAGE = {
  title: msg`Signature already invalid`,
  description: msg`An existing signature on this document is already invalid, so it cannot be signed here. Please contact the sender.`,
};

export const getDistributeErrorMessage = (code: string): ToastMessageDescriptor => {
  return match(code)
    .with('RECIPIENT_LIMIT_EXCEEDED', () => RECIPIENT_LIMIT_EXCEEDED_ERROR_MESSAGE)
    .with(AppErrorCode.TOO_MANY_REQUESTS, () => FAIR_USE_LIMIT_EXCEEDED_ERROR_MESSAGE)
    .with(AppErrorCode.PASSWORD_PROTECTED_DOCUMENT, () => PASSWORD_PROTECTED_DOCUMENT_ERROR_MESSAGE)
    .with(AppErrorCode.SIGNATURE_ALREADY_INVALID, () => SIGNATURE_ALREADY_INVALID_ERROR_MESSAGE)
    .with(AppErrorCode.ENVELOPE_LEGACY, () => LEGACY_OWNER_PROTECTED_ERROR_MESSAGE)
    .with('INVALID_DOCUMENT_FILE', () => DISTRIBUTE_INVALID_DOCUMENT_FILE_ERROR_MESSAGE)
    .otherwise(() => ({
      title: msg`Something went wrong`,
      description: msg`An error occurred while distributing the document.`,
    }));
};

export const getDirectTemplateErrorMessage = (code: string): ToastMessageDescriptor => {
  return match(code)
    .with('RECIPIENT_LIMIT_EXCEEDED', () => RECIPIENT_LIMIT_EXCEEDED_ERROR_MESSAGE)
    .with(AppErrorCode.TOO_MANY_REQUESTS, () => FAIR_USE_LIMIT_EXCEEDED_ERROR_MESSAGE)
    .with(AppErrorCode.MISSING_SIGNATURE_FIELD, () => ({
      title: msg`Missing signature fields`,
      description: msg`This direct link template cannot be used because one or more signers do not have a signature field assigned.`,
    }))
    .with(AppErrorCode.ENVELOPE_LEGACY, () => DIRECT_TEMPLATE_PDF_RESTRICTED_ERROR_MESSAGE)
    .with(AppErrorCode.PASSWORD_PROTECTED_DOCUMENT, () => DIRECT_TEMPLATE_PASSWORD_PROTECTED_ERROR_MESSAGE)
    .with(AppErrorCode.SIGNATURE_ALREADY_INVALID, () => DIRECT_TEMPLATE_SIGNATURE_ALREADY_INVALID_ERROR_MESSAGE)
    .otherwise(() => ({
      title: msg`Something went wrong`,
      description: msg`We were unable to submit this document at this time. Please try again later.`,
    }));
};

/**
 * Toast messages for errors thrown while a recipient attempts to complete
 * (sign) a document, so the user knows whether retrying can help and what to
 * do next.
 */
export const getSigningCompletionErrorMessage = (code: string): ToastMessageDescriptor => {
  return match(code)
    .with(AppErrorCode.NOT_FOUND, () => ({
      title: msg`Document no longer available`,
      description: msg`This document can no longer be signed. It may have been removed by the sender, or your signing access may have been revoked. Please contact the sender for a new signing link.`,
    }))
    .with(AppErrorCode.RECIPIENT_HAS_UNSIGNED_FIELDS, () => ({
      title: msg`Some fields were not saved`,
      description: msg`One or more of your required fields have not been saved. Please refresh the page, complete any empty required fields, and try again.`,
    }))
    .with(AppErrorCode.RECIPIENT_OUT_OF_TURN, () => ({
      title: msg`It's not your turn to sign yet`,
      description: msg`This document is signed in a set order and other recipients must sign before you. You will receive an email when it is your turn.`,
    }))
    .with(AppErrorCode.RECIPIENT_EXPIRED, () => ({
      title: msg`Signing link expired`,
      description: msg`Your signing link has expired. Please contact the sender to request a new one.`,
    }))
    .with(AppErrorCode.ENVELOPE_COMPLETED, () => ({
      title: msg`Document already completed`,
      description: msg`This document has already been completed and no further signatures can be added.`,
    }))
    .with(AppErrorCode.ENVELOPE_REJECTED, () => ({
      title: msg`Document rejected`,
      description: msg`This document has been rejected by a recipient and can no longer be signed.`,
    }))
    .with(AppErrorCode.ENVELOPE_CANCELLED, () => ({
      title: msg`Document cancelled`,
      description: msg`This document has been cancelled by the sender and can no longer be signed. Please contact the sender if you believe this is a mistake.`,
    }))
    .with(AppErrorCode.ENVELOPE_DRAFT, () => ({
      title: msg`Document not ready`,
      description: msg`This document has not been sent for signing yet. Please wait for the sender to send it before signing.`,
    }))
    .with(AppErrorCode.TOO_MANY_REQUESTS, () => ({
      title: msg`Too many attempts`,
      description: msg`Too many attempts have been made to complete this document, which can happen after several incorrect verification codes. Please wait up to an hour, request a new code and try again.`,
    }))
    .otherwise(() => ({
      title: msg`Something went wrong`,
      description: msg`We were unable to submit this document at this time. Please try again later.`,
    }));
};

export const getUploadErrorMessage = (code: string): ToastMessageDescriptor => {
  return match(code)
    .with(AppErrorCode.TOO_MANY_REQUESTS, () => FAIR_USE_LIMIT_EXCEEDED_ERROR_MESSAGE)
    .with('INVALID_DOCUMENT_FILE', () => ({
      title: msg`Error`,
      // Covers an unreadable PDF and one already signed by somebody else that
      // this upload would invalidate. A PDF that needs a password to open has
      // its own code below; owner-only restrictions are accepted.
      description: msg`This PDF cannot be uploaded. It may be unreadable, or carry a signature that uploading would invalidate.`,
    }))
    .with(AppErrorCode.PASSWORD_PROTECTED_DOCUMENT, () => PASSWORD_PROTECTED_DOCUMENT_ERROR_MESSAGE)
    .with(AppErrorCode.SIGNATURE_ALREADY_INVALID, () => SIGNATURE_ALREADY_INVALID_ERROR_MESSAGE)
    .with(AppErrorCode.ENVELOPE_LEGACY, () => LEGACY_OWNER_PROTECTED_ERROR_MESSAGE)
    .with(AppErrorCode.LIMIT_EXCEEDED, () => ({
      title: msg`Error`,
      description: msg`You have reached your document limit for this month. Please upgrade your plan.`,
    }))
    .with('ENVELOPE_ITEM_LIMIT_EXCEEDED', () => ({
      title: msg`Error`,
      description: msg`You have reached the limit of the number of files per envelope.`,
    }))
    .with('UNSUPPORTED_FILE_TYPE', () => ({
      title: msg`Error`,
      description: msg`This file type isn't supported. Please upload a PDF or Word document.`,
    }))
    .with('CONVERSION_SERVICE_UNAVAILABLE', () => ({
      title: msg`Error`,
      description: msg`Document conversion is temporarily unavailable. Please try again shortly or upload a PDF.`,
    }))
    .with('CONVERSION_FAILED', () => ({
      title: msg`Error`,
      description: msg`We couldn't convert this file. Please check it's a valid Word document or upload a PDF instead.`,
    }))
    .otherwise(() => ({
      title: msg`Error`,
      description: msg`An error occurred while uploading your document.`,
    }));
};

export const getTemplateUseErrorMessage = (code: string): ToastMessageDescriptor => {
  return match(code)
    .with('DOCUMENT_SEND_FAILED', () => ({
      title: msg`Error`,
      description: msg`The document was created but could not be sent to recipients.`,
    }))
    .with(AppErrorCode.MISSING_SIGNATURE_FIELD, () => ({
      title: msg`Missing signature fields`,
      description: msg`The document could not be sent because some signers do not have a signature field. Please edit the template and add a signature field for each signer.`,
    }))
    .with(AppErrorCode.INVALID_BODY, AppErrorCode.INVALID_REQUEST, () => ({
      title: msg`Error`,
      description: msg`The document could not be created because of missing or invalid information. Please review the template's recipients and fields.`,
    }))
    .with(AppErrorCode.NOT_FOUND, () => ({
      title: msg`Error`,
      description: msg`The template or one of its recipients could not be found.`,
    }))
    .with(AppErrorCode.LIMIT_EXCEEDED, () => ({
      title: msg`Error`,
      description: msg`You have reached your document limit for this plan. Please upgrade your plan.`,
    }))
    .with(AppErrorCode.TOO_MANY_REQUESTS, () => FAIR_USE_LIMIT_EXCEEDED_ERROR_MESSAGE)
    .with(AppErrorCode.PASSWORD_PROTECTED_DOCUMENT, () => PASSWORD_PROTECTED_DOCUMENT_ERROR_MESSAGE)
    .with(AppErrorCode.SIGNATURE_ALREADY_INVALID, () => SIGNATURE_ALREADY_INVALID_ERROR_MESSAGE)
    .with(AppErrorCode.ENVELOPE_LEGACY, () => LEGACY_OWNER_PROTECTED_ERROR_MESSAGE)
    .otherwise(() => ({
      title: msg`Error`,
      description: msg`An error occurred while creating document from template.`,
    }));
};
