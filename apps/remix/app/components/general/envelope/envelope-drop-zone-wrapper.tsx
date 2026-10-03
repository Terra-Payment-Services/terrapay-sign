import { useAnalytics } from '@documenso/lib/client-only/hooks/use-analytics';
import { useMaximumEnvelopeItemCount } from '@documenso/lib/client-only/hooks/use-maximum-envelope-item-count';
import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT } from '@documenso/lib/constants/app';
import { getAllowedUploadMimeTypes } from '@documenso/lib/constants/document-conversion';
import { DEFAULT_DOCUMENT_TIME_ZONE, TIME_ZONES } from '@documenso/lib/constants/time-zones';
import { AppError } from '@documenso/lib/errors/app-error';
import { megabytesToBytes } from '@documenso/lib/universal/unit-convertions';
import { formatDocumentsPath, formatTemplatesPath } from '@documenso/lib/utils/teams';
import { trpc } from '@documenso/trpc/react';
import type { TCreateEnvelopePayload } from '@documenso/trpc/server/envelope-router/create-envelope.types';
import { buildDropzoneRejectionDescription } from '@documenso/ui/lib/handle-dropzone-rejection';
import { cn } from '@documenso/ui/lib/utils';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { EnvelopeType } from '@prisma/client';
import { Loader } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ErrorCode as DropzoneErrorCode, type FileRejection, useDropzone } from 'react-dropzone';
import { useNavigate, useParams } from 'react-router';

import { useCurrentTeam } from '~/providers/team';
import { getUploadErrorMessage } from '~/utils/toast-error-messages';

export interface EnvelopeDropZoneWrapperProps {
  children: ReactNode;
  type: EnvelopeType;
  className?: string;
}

export const EnvelopeDropZoneWrapper = ({ children, type, className }: EnvelopeDropZoneWrapperProps) => {
  const { t, i18n } = useLingui();
  const { toast } = useToast();
  const { folderId } = useParams();

  const team = useCurrentTeam();

  const navigate = useNavigate();
  const analytics = useAnalytics();

  const [isLoading, setIsLoading] = useState(false);

  const userTimezone =
    TIME_ZONES.find((timezone) => timezone === Intl.DateTimeFormat().resolvedOptions().timeZone) ??
    DEFAULT_DOCUMENT_TIME_ZONE;

  const maximumEnvelopeItemCount = useMaximumEnvelopeItemCount();

  const { mutateAsync: createEnvelope } = trpc.envelope.create.useMutation();

  const onFileDrop = async (files: File[]) => {
    try {
      setIsLoading(true);

      const payload = {
        folderId,
        type,
        title: files[0].name,
        meta: {
          timezone: userTimezone,
        },
      } satisfies TCreateEnvelopePayload;

      const formData = new FormData();

      formData.append('payload', JSON.stringify(payload));

      for (const file of files) {
        formData.append('files', file);
      }

      const { id } = await createEnvelope(formData);

      toast({
        title: type === EnvelopeType.DOCUMENT ? t`Document uploaded` : t`Template uploaded`,
        description:
          type === EnvelopeType.DOCUMENT
            ? t`Your document has been uploaded successfully.`
            : t`Your template has been uploaded successfully.`,
        duration: 5000,
      });

      const pathPrefix = type === EnvelopeType.DOCUMENT ? formatDocumentsPath(team.url) : formatTemplatesPath(team.url);

      await navigate(`${pathPrefix}/${id}/edit`);
    } catch (err) {
      const error = AppError.parseError(err);

      analytics.captureException(err, {
        source: 'editor',
        location: 'upload_document',
      });

      const errorMessage = getUploadErrorMessage(error.code);

      toast({
        title: i18n._(errorMessage.title),
        description: i18n._(errorMessage.description),
        variant: 'destructive',
        duration: 7500,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const onFileDropRejected = (fileRejections: FileRejection[]) => {
    if (!fileRejections.length) {
      return;
    }

    const maxItemsReached = fileRejections.some((fileRejection) =>
      fileRejection.errors.some((error) => error.code === DropzoneErrorCode.TooManyFiles),
    );

    if (maxItemsReached) {
      toast({
        title: plural(maximumEnvelopeItemCount, {
          one: `You cannot upload more than # item per envelope.`,
          other: `You cannot upload more than # items per envelope.`,
        }),
        duration: 5000,
        variant: 'destructive',
      });

      return;
    }

    toast({
      title: t`Upload failed`,
      description: i18n._(buildDropzoneRejectionDescription(fileRejections)),
      duration: 5000,
      variant: 'destructive',
    });
  };
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: getAllowedUploadMimeTypes(),
    multiple: true,
    maxSize: megabytesToBytes(APP_DOCUMENT_UPLOAD_SIZE_LIMIT),
    maxFiles: maximumEnvelopeItemCount,
    onDrop: (files) => void onFileDrop(files),
    onDropRejected: onFileDropRejected,
    noClick: true,
    noDragEventsBubbling: true,
  });

  return (
    <div {...getRootProps()} className={cn('relative min-h-screen', className)}>
      <input {...getInputProps()} />
      {children}

      {isDragActive && (
        <div className="fixed top-0 left-0 z-[9999] h-full w-full bg-muted/60 backdrop-blur-[4px]">
          <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center">
            <h2 className="font-semibold text-2xl text-foreground">
              {type === EnvelopeType.DOCUMENT ? <Trans>Upload Document</Trans> : <Trans>Upload Template</Trans>}
            </h2>

            <p className="mt-4 text-base text-muted-foreground">
              <Trans>Drag and drop your document here</Trans>
            </p>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="absolute inset-0 z-50 bg-muted/30 backdrop-blur-[2px]">
          <div className="pointer-events-none flex h-1/2 w-full flex-col items-center justify-center">
            <Loader className="h-12 w-12 animate-spin text-primary" />
            <p className="mt-8 font-medium text-foreground">
              <Trans>Uploading</Trans>
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
