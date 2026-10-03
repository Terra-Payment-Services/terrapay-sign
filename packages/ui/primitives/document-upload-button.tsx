import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT } from '@documenso/lib/constants/app';
import { getAllowedUploadMimeTypes } from '@documenso/lib/constants/document-conversion';
import { megabytesToBytes } from '@documenso/lib/universal/unit-convertions';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { EnvelopeType } from '@prisma/client';
import { Upload } from 'lucide-react';
import type { DropEvent, FileRejection } from 'react-dropzone';
import { useDropzone } from 'react-dropzone';

import { Button } from './button';

export type DocumentUploadButtonProps = {
  className?: string;
  disabled?: boolean;
  loading?: boolean;
  disabledMessage?: MessageDescriptor;
  onDrop?: (_files: File[]) => void | Promise<void>;
  onDropRejected?: (fileRejections: FileRejection[], event: DropEvent) => void;
  type: EnvelopeType;
  internalVersion: '1' | '2';
  maxFiles?: number;
  [key: string]: unknown;
};

export const DocumentUploadButton = ({
  className,
  loading,
  onDrop,
  onDropRejected,
  disabled,
  disabledMessage = msg`You cannot upload documents at this time.`,
  type,
  internalVersion,

  maxFiles,
  ...props
}: DocumentUploadButtonProps) => {
  const { _ } = useLingui();

  const { getRootProps, getInputProps } = useDropzone({
    accept: getAllowedUploadMimeTypes(),
    multiple: internalVersion === '2',
    disabled,
    maxFiles,
    onDrop: (acceptedFiles) => {
      if (acceptedFiles.length > 0 && onDrop) {
        void onDrop(acceptedFiles);
      }
    },
    onDropRejected,
    maxSize: megabytesToBytes(APP_DOCUMENT_UPLOAD_SIZE_LIMIT),
  });

  const heading = {
    [EnvelopeType.DOCUMENT]: internalVersion === '1' ? msg`Document (Legacy)` : msg`Upload Document`,
    [EnvelopeType.TEMPLATE]: internalVersion === '1' ? msg`Template (Legacy)` : msg`Upload Template`,
  };

  return (
    <Button loading={loading} aria-disabled={disabled} {...getRootProps()} {...props}>
      <div className="flex items-center gap-2">
        <input data-testid="document-upload-input" {...getInputProps()} />
        {!loading && <Upload className="h-4 w-4" />}
        {disabled ? _(disabledMessage) : _(heading[type])}
      </div>
    </Button>
  );
};
