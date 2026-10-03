import path from 'node:path';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { FontLibrary } from '@documenso/skia-canvas';
import type { Recipient } from '@prisma/client';
import { FieldType } from '@prisma/client';
import { match } from 'ts-pattern';

import {
  formatPlaceholderRecipientEmail,
  isPlaceholderRecipientEmailForIndex,
} from '../../constants/placeholder-recipients';

/**
 * The font files shipped for server-side PDF rendering, keyed by the family name
 * the renderers ask for.
 *
 * Exported so a test can check the certificate's font stack against the glyphs these
 * files carry. Without that check the coverage of an evidence document depends on the
 * font book of whichever machine produced it.
 *
 * Every file is a static instance. Skia's PDF backend cannot embed a variable font as
 * TrueType, so it writes one Type 3 font per weight drawn, and on the Linux runtime
 * image those fonts carry glyphs of the wrong weight: a word set at 500 comes out with
 * some letters at 400, and the other way round. macOS does not show it. The browser
 * still loads the variable files through app.css, which is why both copies ship.
 * The Japanese and Korean files are Regular instances cut from the variable Noto
 * fonts, matching the static Regular Chinese file beside them.
 */
export const PDF_FONT_FILES: Record<string, string[]> = {
  Caveat: ['caveat.ttf'],
  Inter: ['inter-regular.ttf', 'inter-semibold.ttf', 'inter-bold.ttf'],
  'Source Sans 3': ['SourceSans3-Regular.ttf', 'SourceSans3-Medium.ttf'],
  'TT Firs Neue': ['TTFirsNeue-Regular.ttf', 'TTFirsNeue-Medium.ttf', 'TTFirsNeue-DemiBold.ttf'],
  'Noto Sans': ['noto-sans.ttf'],
  'Noto Sans Arabic': ['noto-sans-arabic.ttf'],
  'Noto Sans Japanese': ['noto-sans-japanese-regular.ttf'],
  'Noto Sans Chinese': ['noto-sans-chinese.ttf'],
  'Noto Sans Korean': ['noto-sans-korean-regular.ttf'],
};

const resolveFontFiles = (fontPath: string, families: string[]) =>
  Object.fromEntries(
    families.map((family) => [family, PDF_FONT_FILES[family].map((file) => path.join(fontPath, file))]),
  );

/**
 * Ensure all required fonts are registered in the skia-canvas FontLibrary.
 *
 * Fonts are registered once per process and retained — calling this multiple
 * times is a no-op after the first invocation.
 */
export const ensureFontLibrary = () => {
  const fontPath = path.join(process.cwd(), 'public/fonts');

  if (!FontLibrary.has('Caveat')) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    FontLibrary.use(resolveFontFiles(fontPath, ['Caveat']));
  }

  if (!FontLibrary.has('Inter')) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    FontLibrary.use(resolveFontFiles(fontPath, ['Inter']));
  }

  if (!FontLibrary.has('Source Sans 3')) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    FontLibrary.use(resolveFontFiles(fontPath, ['Source Sans 3']));
  }

  if (!FontLibrary.has('TT Firs Neue')) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    FontLibrary.use(resolveFontFiles(fontPath, ['TT Firs Neue']));
  }

  if (!FontLibrary.has('Noto Sans')) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    FontLibrary.use(
      resolveFontFiles(fontPath, [
        'Noto Sans',
        'Noto Sans Arabic',
        'Noto Sans Japanese',
        'Noto Sans Chinese',
        'Noto Sans Korean',
      ]),
    );
  }
};

type RecipientPlaceholderInfo = {
  email: string;
  name: string;
  recipientIndex: number;
};

/*
  Parse field type string to FieldType enum.
  Normalizes the input (uppercase, trim) and validates it's a valid field type.
  This ensures we handle case variations and whitespace, and provides clear error messages.
*/
export const parseFieldTypeFromPlaceholder = (fieldTypeString: string): FieldType => {
  const normalizedType = fieldTypeString.toUpperCase().trim();

  return match(normalizedType)
    .with('SIGNATURE', () => FieldType.SIGNATURE)
    .with('FREE_SIGNATURE', () => FieldType.FREE_SIGNATURE)
    .with('INITIALS', () => FieldType.INITIALS)
    .with('NAME', () => FieldType.NAME)
    .with('EMAIL', () => FieldType.EMAIL)
    .with('DATE', () => FieldType.DATE)
    .with('TEXT', () => FieldType.TEXT)
    .with('NUMBER', () => FieldType.NUMBER)
    .with('RADIO', () => FieldType.RADIO)
    .with('CHECKBOX', () => FieldType.CHECKBOX)
    .with('DROPDOWN', () => FieldType.DROPDOWN)
    .otherwise(() => {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `Invalid field type: ${fieldTypeString}`,
      });
    });
};

/*
  Transform raw field metadata from placeholder format to schema format.
  Users should provide properly capitalized property names (e.g., readOnly, fontSize, textAlign).
  Converts string values to proper types (booleans, numbers).
*/
export const parseFieldMetaFromPlaceholder = (
  rawFieldMeta: Record<string, string>,
  fieldType: FieldType,
): Record<string, unknown> | undefined => {
  if (fieldType === FieldType.SIGNATURE || fieldType === FieldType.FREE_SIGNATURE) {
    return;
  }

  if (Object.keys(rawFieldMeta).length === 0) {
    return;
  }

  const fieldTypeString = String(fieldType).toLowerCase();

  const parsedFieldMeta: Record<string, boolean | number | string> = {
    type: fieldTypeString,
  };

  /*
    rawFieldMeta is an object with string keys and string values.
    It contains string values because the PDF parser returns the values as strings.

    E.g. { 'required': 'true', 'fontSize': '12', 'maxValue': '100', 'minValue': '0', 'characterLimit': '100' }
  */
  const rawFieldMetaEntries = Object.entries(rawFieldMeta);

  for (const [property, value] of rawFieldMetaEntries) {
    if (property === 'readOnly' || property === 'required') {
      parsedFieldMeta[property] = value === 'true';
    } else if (
      property === 'fontSize' ||
      property === 'maxValue' ||
      property === 'minValue' ||
      property === 'characterLimit'
    ) {
      const numValue = Number(value);

      if (!Number.isNaN(numValue)) {
        parsedFieldMeta[property] = numValue;
      }
    } else {
      parsedFieldMeta[property] = value;
    }
  }

  return parsedFieldMeta;
};

const extractRecipientPlaceholder = (placeholder: string): RecipientPlaceholderInfo => {
  const indexMatch = placeholder.match(/^r(\d+)$/i);

  if (!indexMatch) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: `Invalid recipient placeholder format: ${placeholder}. Expected format: r1, r2, r3, etc.`,
    });
  }

  const recipientIndex = Number(indexMatch[1]);

  return {
    email: formatPlaceholderRecipientEmail(recipientIndex),
    name: `Recipient ${recipientIndex}`,
    recipientIndex,
  };
};

/*
  Finds a recipient based on a placeholder reference.
  If recipients array is provided, uses index-based matching (r1 -> recipients[0], etc.).
  Otherwise, uses email-based matching from createdRecipients.
*/
export const findRecipientByPlaceholder = (
  recipientPlaceholder: string,
  placeholder: string,
  recipients: Pick<Recipient, 'id' | 'email'>[] | undefined,
  createdRecipients: Pick<Recipient, 'id' | 'email'>[],
): Pick<Recipient, 'id' | 'email'> => {
  if (recipients && recipients.length > 0) {
    /*
      Map placeholder by index: r1 -> recipients[0], r2 -> recipients[1], etc.
      recipientIndex is 1-based, so we subtract 1 to get the array index.
    */
    const { recipientIndex } = extractRecipientPlaceholder(recipientPlaceholder);
    const recipientArrayIndex = recipientIndex - 1;

    if (recipientArrayIndex < 0 || recipientArrayIndex >= recipients.length) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `Recipient placeholder ${recipientPlaceholder} (index ${recipientIndex}) is out of range. Provided ${recipients.length} recipient(s).`,
      });
    }

    return recipients[recipientArrayIndex];
  }

  /*
    Use email-based matching for placeholder recipients.
  */
  const { recipientIndex } = extractRecipientPlaceholder(recipientPlaceholder);
  const recipient = createdRecipients.find((r) => isPlaceholderRecipientEmailForIndex(r.email, recipientIndex));

  if (!recipient) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: `Could not find recipient ID for placeholder: ${placeholder}`,
    });
  }

  return recipient;
};
