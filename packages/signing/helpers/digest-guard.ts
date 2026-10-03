import { verify, X509Certificate } from 'node:crypto';
import type { DigestAlgorithm, Signer } from '@libpdf/core';

const NODE_DIGEST_NAMES: Record<DigestAlgorithm, string> = {
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
};

/**
 * Fixed, meaningless bytes. Signing them proves nothing about any document, it
 * only exercises the key path the way libpdf will exercise it.
 */
const PROBE = new TextEncoder().encode('documenso signing digest probe');

/**
 * Prove that a signer really signs with the digest it is asked for.
 *
 * WebCrypto binds the digest to an RSA key when the key is imported, so a
 * signer holding a key imported under one digest will happily return a
 * signature computed under that digest while the CMS layer declares another.
 * The resulting document names an algorithm it did not use, verifies nowhere,
 * and raises no error on the way out. @libpdf/core 0.4.2 shipped exactly that
 * bug in `P12Signer.importPrivateKey`, patched here in
 * `patches/@libpdf+core+0.4.2.patch`.
 *
 * This signs a fixed probe and verifies the result against the signer's own
 * certificate under the same digest. A signer that lies about its digest fails
 * the verification and throws, at startup, rather than sealing documents
 * nobody can validate.
 *
 * It also refuses an RSA-PSS key outright, which is a separate defect in the
 * same library and was found by reviewing the CSC transport rather than this
 * one. `getSignatureAlgorithmOid` picks the CMS signature OID from `keyType`
 * alone, so every RSA signer is declared `sha256WithRSAEncryption`, and the
 * `SignerInfo` carries a bare AlgorithmIdentifier with no PSS parameters.
 * libpdf's own tables still hand `signatureAlgorithm: 'RSA-PSS'` to that
 * function for a PSS-keyed PKCS#12 and for four Cloud KMS algorithms, and it
 * is discarded. The document then declares PKCS#1 v1.5 over PSS bytes and no
 * verifier accepts it.
 *
 * This check used to verify such a signature with PSS padding and pass it,
 * which made the guard agree with a document that could not validate. Refusing
 * is the only honest answer while libpdf cannot write the parameters.
 *
 * It matters for the certificate TerraPay is procuring. A qualified seal whose
 * key is restricted to PSS cannot be used with this build, so that is a
 * question to settle with the CA before the certificate is issued rather than
 * on the day it arrives.
 *
 * Only call this for signers whose key is local. A remote HSM or CSC signer
 * charges for every signature and may need a fresh authorisation for each one.
 *
 * @param signer - the signer to exercise
 * @param digestAlgorithm - the digest every signature will declare
 * @throws {Error} if the signature does not verify under that digest, or if the
 *   key is an RSA-PSS key, which this library cannot declare correctly
 */
export const assertSignerHonoursDigest = async (signer: Signer, digestAlgorithm: DigestAlgorithm): Promise<void> => {
  const nodeDigestName = NODE_DIGEST_NAMES[digestAlgorithm];

  if (!nodeDigestName) {
    throw new Error(`Unsupported signing digest algorithm: "${digestAlgorithm}".`);
  }

  const publicKey = new X509Certificate(Buffer.from(signer.certificate)).publicKey;

  // Both spellings of the same thing. A signer may announce PSS, and a
  // certificate may restrict its key to PSS through its SubjectPublicKeyInfo,
  // in which case Node reports the type as rsa-pss whatever the signer says.
  if (signer.signatureAlgorithm === 'RSA-PSS' || publicKey.asymmetricKeyType === 'rsa-pss') {
    throw new Error(
      'This signing key uses RSA-PSS, and @libpdf/core cannot declare RSA-PSS in the CMS structure it ' +
        'builds: it writes a PKCS#1 v1.5 algorithm identifier for every RSA key and emits no PSS ' +
        'parameters. Every document sealed with this key would carry PSS bytes under a PKCS#1 v1.5 ' +
        'label and would fail validation in Acrobat and in the EU DSS validator. Use a key that signs ' +
        'with PKCS#1 v1.5, or an EC key. Refusing to sign.',
    );
  }

  const signature = await signer.sign(PROBE, digestAlgorithm);

  if (!verify(nodeDigestName, PROBE, publicKey, signature)) {
    throw new Error(
      `The configured signer produced a signature that does not verify under ${digestAlgorithm}. ` +
        'Its key is most likely bound to a different digest, which would make every sealed ' +
        'document declare an algorithm it did not use. Refusing to sign.',
    );
  }
};
