import type { TUploadPdfResponse } from '@documenso/remix/server/api/files/files.types';

import { formatPath } from '../../constants/app';
import { AppError } from '../../errors/app-error';

type File = {
  name: string;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export const putPdfFile = async (file: File) => {
  const formData = new FormData();

  // Create a proper File object from the data
  const buffer = await file.arrayBuffer();
  const blob = new Blob([buffer], { type: file.type });
  const properFile = new File([blob], file.name, { type: file.type });

  formData.append('file', properFile);

  const response = await fetch(formatPath('/api/files/upload-pdf'), {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    console.error('Upload failed:', response.statusText);

    // The server names some refusals, and the upload toasts are keyed on that code.
    const refusal = AppError.parseFromJSON(await response.json().catch(() => null));

    throw refusal ?? new AppError('UPLOAD_FAILED');
  }

  const result: TUploadPdfResponse = await response.json();

  return result;
};
