import { useEffect, useState } from 'react';

import { assessSignatureInk } from '../../universal/signature/assess-signature-ink';
import { hasVisibleSignatureCharacter } from '../../universal/signature/has-visible-signature-character';
import { isSignatureImageValue, toCanonicalSignatureImage } from '../../universal/signature/is-signature-image-value';

/**
 * Decodes a PNG data URL in the browser and applies the shared ink rule (D1).
 *
 * @param dataUrl The saved signature image.
 * @returns Whether the image decodes and has enough ink to be offered.
 */
export const isSignatureImageInked = async (dataUrl: string) => {
  const image = new Image();

  image.src = dataUrl;

  const isDecoded = await image.decode().then(
    () => true,
    () => false,
  );

  const { naturalWidth: width, naturalHeight: height } = image;
  const context = document.createElement('canvas').getContext('2d');

  if (!isDecoded || !context || width === 0 || height === 0) {
    return false;
  }

  context.canvas.width = width;
  context.canvas.height = height;
  context.drawImage(image, 0, 0);

  return assessSignatureInk(context.getImageData(0, 0, width, height).data, width, height).isValid;
};

/**
 * Holds a saved signature back until the shared ink rule has passed on it (#126, G4 rule 8).
 *
 * A saved image starts as no signature, so an early click opens the dialog; it is offered once the check passes,
 * unless a signature was set meanwhile. A saved typed signature is offered at once when it has a visible character,
 * and withheld otherwise. When the saved value changes (the profile form after a save), the offer starts again from
 * the new value.
 *
 * @param savedValue The saved signature. An image is classified as the server classifies it (trimmed, `data:` in any
 * case) and offered with the prefix in lower case (G4 C101).
 * @returns The signature to offer, its setter, and whether the saved value was refused.
 */
export const useOfferedSignature = (savedValue: string | null) => {
  // Classified as the server classifies it; an image is offered in the spelling the pad and the routes read.
  const isImage = !!savedValue && isSignatureImageValue(savedValue);
  const saved = savedValue && isImage ? toCanonicalSignatureImage(savedValue) : savedValue;
  const isBlankTyped = !!saved && !isImage && !hasVisibleSignatureCharacter(saved);

  const [signature, setSignature] = useState(isImage || isBlankTyped ? null : saved);
  const [isWithheld, setIsWithheld] = useState(isBlankTyped);

  useEffect(() => {
    setIsWithheld(isBlankTyped);

    if (isBlankTyped) {
      setSignature(null);

      return;
    }

    if (!saved || !isImage) {
      setSignature(saved);

      return;
    }

    setSignature(null);

    let isCurrent = true;

    void isSignatureImageInked(saved).then((isInked) => {
      if (!isCurrent) {
        return;
      }

      if (isInked) {
        setSignature((current) => current ?? saved);
      } else {
        setIsWithheld(true);
      }
    });

    return () => {
      isCurrent = false;
    };
  }, [saved, isImage, isBlankTyped]);

  return { signature, setSignature, isWithheld };
};
