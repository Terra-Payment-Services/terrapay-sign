# TerraPay Sign: notice of modification

TerraPay Sign is a modified version of Documenso, the open source document signing
platform, and TerraPay runs it as its internal e-signature service. TerraPay modified the
program, and this version is dated 2 October 2026. This file is the notice that section
5(a) of the GNU Affero General Public License, version 3, requires of a modified work.

The program is based on upstream's `main` branch at commit `5603a9e5`, six commits after
the release tag `v2.18.0`. That commit and everything before it are upstream's; the single
commit on top of it holds all of TerraPay's changes. The upstream code and TerraPay's
changes are distributed under the GNU Affero General Public License, version 3, as set
out in `LICENSE`. The program contains none of Documenso's Enterprise Edition code.

The sections below describe what TerraPay changed, by area.

## Sign-in and identity

Sign-in goes through a single Microsoft Entra ID tenant, and Entra is the only way in.
Upstream's Microsoft provider was fixed to the multi-tenant authority and required an
email claim that Entra does not emit, so the tenant is configurable, and the one
combination of settings that would let any Microsoft tenant assert any address is refused
at startup. Fallback claims added for Entra apply to that provider alone.

The signature on every ID token is verified against the authority's published keys, and
the HMAC algorithms are refused outright. The token's issuer is bound to the address its
discovery document came from, the authority's address is checked on every request, and
each linked account is keyed on the issuer of its token rather than on a local provider
label. That last change adds a database column and a backfill script.

The email and password form and the passkey button are gone from the sign-in page, and
the passkey route itself refuses, so a person removed from the directory keeps no
credential the application holds on its own. Public signup is closed. An account is
created only by signing in through Entra with an address on the configured domain, and a
new user joins the deployment's single organisation rather than receiving a personal one.
Only an administrator can create that organisation, and no one can create a second.

A scheduled job reconciles access against the directory, either a configured group or the
whole tenant, so a person who leaves loses access without a manual step. Disabled,
deleted and guest accounts count as gone, and disabling a user ends the sessions they
already hold.

## Roles and authorisation

Several ways for an organisation manager to raise their own role are closed. Setting the
default role given to people who arrive through single sign-on is guarded as a role grant,
both when the role is chosen and when a link token is redeemed. A role change that would
have no effect, because the person's groups grant a higher role, is refused with the names
of those groups, and the rows involved are locked while the decision is made so that a
concurrent change cannot slip underneath it.

## Signing and certificates

Upstream flattens and rewrites every uploaded PDF, which silently destroys a signature
that a counterparty applied with another product. This version detects an existing
signature, flattens with signature fields left alone, saves incrementally and then checks
that the original bytes survive unchanged at the start of the output. Upstream's bundled
development certificate is replaced, and the PDF library is patched so that a signature
uses the digest algorithm it declares. Signatures are made to PAdES B-LTA, with an RFC 3161
timestamp and embedded validation data, once a timestamp authority is configured.

Validation data is not trusted until it is checked. Revocation responses are verified,
and the certificate that issued them is proved before it is believed. Timestamp tokens
are verified for their signature, message imprint, nonce and time. An answer from a remote
signing service is checked against the credential's own certificate before it is
embedded, and an RSA-PSS key is refused because the PDF library cannot declare one
correctly. A signing transport for a remote service implementing the Cloud Signature
Consortium API is included, selected by configuration and written from that published
specification.

## The certificate of completion

The certificate of completion is the evidence a dispute turns on. It does not record that
an email was sent to a recipient who was never mailed, which upstream did for an in-person
signer with no address. Fonts are bundled so that names written in Arabic, Devanagari,
Han, Cyrillic and other non-Latin scripts are legible whatever fonts the producing machine
has installed, and the files are static instances, because the PDF backend printed some
letters of a word at the wrong weight from variable fonts. The certificate is produced in
English.

## Document integrity and access control

Four upstream defects that could destroy or corrupt a signed contract are fixed. A
recipient who has already signed can no longer reject, which erased the time they signed.
Replacing a recipient list can no longer delete a signed recipient and their signature. A
rejected contract is no longer sealed showing unfilled signature fields. An author who
loses team access no longer leaves every contract they sent unsealed for good.

The file route applies the envelope's visibility rather than returning a document's bytes
to every team member, as upstream issue #3112 (advisory GHSA-fqg2-7p6q-9v9q) describes. A
signature the signer cancelled can no longer reach the document on the next visit to the
field, as upstream issue #3203 reported. An assistant recipient can no longer place or
remove a signature in another recipient's name, tracked as CVE-2026-71247, and clearing a
field is recorded in the audit log whoever does it. Uploaded document data records who
uploaded it, so nobody else can attach it to their own envelope, and completion webhooks
go to the team that owns the document. A retried completion job does not send the
completion emails and webhooks twice, and a retried seal job does not seal a finished
envelope again.

## Recipient and server security

The client address that audit rows record and rate limits count is read from the
right-hand end of `X-Forwarded-For`, which the trusted proxy writes, rather than from the
left, which the client controls. Access rules are checked on every signing action and not
only when the page loads. An emailed access code locks for an hour after five wrong
attempts, and a document it protects is withheld, with its files, until the code is
entered. Writes authenticated by a cookie are refused when they come from another origin.

Webhook delivery connects only to the address it has just validated, fails closed when
the address cannot be resolved, and caps the response it stores. Request bodies are capped
before anything reads them, and a presign token cannot reach another team's documents.
Signing tokens are kept out of logs, only embedded pages may be framed, and the health
endpoint does not publish error detail.

## Signing pages and staff screens

The button that published a signer's name and signature as a shareable card is removed,
along with the code behind it. "Require account" is not offered as an access rule, because
an external signer cannot hold an account. A document that still has a placeholder
recipient is refused at send. Placeholder addresses use the reserved `.invalid` domain,
and webhooks carry their secret in an `X-TerraPay-Secret` header as well as upstream's
header. Staff who need help are sent to the deployment's own support address, billing code
that could never run here is deleted, and the security settings offer only the options
the deployment supports. All ten offered languages are fully translated.

## Archiving to SharePoint

Every completed document is filed to a SharePoint document library, so that executed
contracts are kept where the organisation's retention rules apply. Each file name carries
the document's own identifier, uploads never replace an existing file, an existing file is
accepted as the contract only when its bytes match exactly, and only one run can file a
given document. The health endpoint reports whether filing is working.

## Email through Microsoft Graph

The application sends email through Microsoft Graph as a single mailbox, in place of SMTP
with a username and password. A message too large for one Graph request, such as a
completion email carrying the signed contract, is sent as a draft with its attachments
uploaded separately. A send is recorded only when Graph returns the response it documents
for a successful send, and no Graph request follows a redirect.

## Removal of features that sent data outside

Every upstream feature that called a third party is removed. An optional feature sent an
image of every page of a document to Google, with recipient names and addresses, to detect
fields and recipients. Telemetry, analytics, the licence server check and the captcha went
with it, as did upstream's public statistics service.

## The Enterprise Edition code

`packages/ee` was upstream's Enterprise Edition, under Documenso's commercial licence,
which permits production use only under an Enterprise subscription. TerraPay holds none,
so the directory and every dependency on it are removed, and a test fails the build if
either returns. Each replacement was written from the code that calls it and never from
the Enterprise implementation. Usage limits come from a function this version owns.
Stripe billing, the per-organisation single sign-on portal, organisation email domains and
recipient signing through a remote trust service provider were removed rather than
replaced.

## Appearance

Documenso's colours and fonts are replaced with TerraPay's design system, which also raises
error text, input borders and danger buttons to the contrast WCAG AA asks for, and the
product is called TerraPay Sign throughout. This copy carries upstream's logos and icons in
place of TerraPay's, which are trademarks, and leaves out the TT Firs Neue font files,
which TerraPay licenses and may not redistribute. Anyone building it supplies their own.

## Testing

Unit tests accompany each change, in `packages/lib`, `packages/auth` and
`packages/signing`. The end-to-end suite covers the changed flows, and a subset of it can
run against a deployed instance, including a test that creates, signs and seals a document
through the public API.

## Upstream

Documenso is developed at <https://github.com/documenso/documenso>. Its `README.md`, which
this repository keeps below a short preface, describes the unmodified product and its own
way of running it. Where the README and this file differ about TerraPay Sign, this file is
the record of what TerraPay changed.
