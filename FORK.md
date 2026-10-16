# TerraPay Sign: notice of modification

TerraPay Sign is a modified version of Documenso, the open source document signing
platform, and TerraPay runs it as its internal e-signature service. TerraPay modified the
program, and this version is dated 16 October 2026. This file is the notice that section
5(a) of the GNU Affero General Public License, version 3, requires of a modified work.

The program is based on upstream's `main` branch at commit `5603a9e5`, six commits after
the release tag `v2.18.0`. That commit and everything before it are upstream's; the
commits on top of it hold TerraPay's changes, one for each version TerraPay has published.
The upstream code and TerraPay's changes are distributed under the GNU Affero General
Public License, version 3, as set out in `LICENSE`. The program contains none of
Documenso's Enterprise Edition code.

The sections below describe what TerraPay changed, by area.

## Sign-in and identity

Sign-in goes through a single Microsoft Entra ID tenant, and Entra is the only way in.
Upstream's Microsoft provider was fixed to the multi-tenant authority and required an
email claim that Entra does not emit, so the tenant is configurable, and the one
combination of settings that would let any Microsoft tenant assert any address is refused
at startup. Fallback claims added for Entra apply to that provider alone. Upstream's
Google and generic OpenID Connect sign-in code is removed, and the server refuses every
provider other than Microsoft before it creates or links an account.

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
Only an administrator can create that organisation, and no one can create a second. A
session ends eight hours after sign-in and is never extended by use.

A signer who must be signed in to act, as for a company seal, is sent from the signing page
to the sign-in page, which used to hide its Microsoft button on that route and so showed an
empty form; the button now stays. The address a person returns to after sign-in has any
leading run of slashes and backslashes collapsed to one, and is dropped unless it resolves
to the application's own origin, so a value such as `/.//evil.com` cannot send the browser,
or the server's redirect at the end of single sign-on, to another site. Two-factor setup is
refused while two-factor is on, so a signed-in session cannot replace the authenticator and
backup codes without a code. Enabling two-factor succeeds only while the stored secret is
the one whose code was checked, so a setup that lands in the middle cannot leave two-factor
on for a secret the user never confirmed.

A scheduled job reconciles access against the directory, either a configured group or the
whole tenant, so a person who leaves loses access without a manual step. Disabled,
deleted and guest accounts count as gone, and disabling a user ends the sessions they
already hold. The deployment's own system accounts are left out of the count.

The reconcile is guarded before it is allowed to disable anyone. An account is matched to
the directory on the immutable Entra object id carried in the ID token stored at sign-in,
accepted only when the token's tenant is the configured one, so a renamed user keeps their
account and a reassigned address cannot keep a leaver's. An account with no such id is
matched on its address alone. Addresses can be exempted from disabling by configuration.
The minimum-membership floor and the largest share of users one run may disable must parse
as valid numbers, and a bad value stops the job rather than falling back to a default.
A directory user whose enabled state is missing is read as not enabled, and only enabled
users count toward the floor. A production server refuses to start while the reconcile
would do nothing, or while a setting points the job at another Graph or login address. Each Graph request gives up if it is not answered within a
minute, and a continuation link is followed only when it is HTTPS on the Graph origin.

## Roles and authorisation

Several ways for an organisation manager to raise their own role are closed. Setting the
default role given to people who arrive through single sign-on is guarded as a role grant,
both when the role is chosen and when a link token is redeemed. A role change that would
have no effect, because the person's groups grant a higher role, is refused with the names
of those groups, and the rows involved are locked while the decision is made so that a
concurrent change cannot slip underneath it.

Recipient suggestions include a team's members only when the person asking belongs to that
team. The team was taken from a request header and never checked, so a signed-in user could name
another organisation's team and read its members' names and addresses.

## Signing and certificates

Upstream flattens and rewrites every uploaded PDF, which silently destroys a signature
that a counterparty applied with another product. This version detects an existing
signature, flattens with signature fields left alone, saves incrementally and then checks
that the original bytes survive unchanged at the start of the output. Upstream's bundled
development certificate is replaced, and the PDF library is patched so that a signature
uses the digest algorithm it declares. Signatures are made to PAdES B-LTA, with an RFC
3161 timestamp and embedded validation data, once a timestamp authority is configured.

A PDF that opens without a password but carries owner restrictions, which signing tools
such as Adobe Acrobat often produce, is accepted, where upstream refused every encrypted
file. The restrictions are kept, and a signature already on the file is kept with them.
A PDF that needs a password to open is refused with its own error and message. The PDF
library decrypts an object by rebuilding it and marking it changed, so an incremental save
rewrote every encrypted object that had merely been read, including an existing signature's
contents, and the signature no longer verified in other readers. The library patch now also clears
that mark after decryption. A signature already broken on arrival, or one
in a format the program cannot check, is refused at upload, and each signer's signature is
verified rather than only its digest. The same checks run on the bytes as received, before
form values are filled, and the pending download is flattened around existing signatures
and appended to, so the original bytes stay a prefix of the output. A legacy (V1) document
cannot keep owner restrictions, because its sealing path drops them, so a restricted PDF is
refused there, whether it is sent directly, copied or made from a template, with a message
that names the cause. An uploaded PDF is parsed once in each stage and the parsed document
is handed on, where it was parsed again in every stage. The messages shown when a protected
or broken PDF is refused are in the translation catalogs. A signature that carries its own
revocation lists and a timestamp, as PandaDoc's do, can need more than the 10,000 ASN.1
nodes the parsing library allows by default, and such a file was refused as already
broken; the signature parser now allows 100,000, which still bounds what a sender can make
it read.

Validation data is not trusted until it is checked. Revocation responses are verified,
and the certificate that issued them is proved before it is believed. Timestamp tokens
are verified for their signature, message imprint, nonce and time, and their signer must
chain, every link checked, to one of the timestamp authorities' root keys that the
deployment pins, so that whoever can answer for an authority's address cannot set the time
a document claims. Before a revocation list is fetched, the certificate it is to cover must
be shown to be signed by the issuer that was found for it. Sectigo's timestamp root names
no address for its own issuer, so every document timestamped by Sectigo failed the
revocation check and was sealed only on a retry. The signing package now carries the
USERTrust RSA root, checked against its SHA-256 on first use, as an issuer that may verify
a revocation list and for nothing else: it is not a trust anchor and the timestamp pin
ignores it. A list that has been verified is reused within the signing of one document. An answer from a remote
signing service is checked against the credential's own certificate before it is
embedded, and an RSA-PSS key is refused because the PDF library cannot declare one
correctly. A signing transport for a remote service implementing the Cloud Signature
Consortium API is included, selected by configuration and written from that published
specification, and in production it refuses to start unless the signing service's
certificate is pinned by its SHA-256 fingerprint.

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

A legacy (V1) document's PDF is checked again whenever the document is about to notify
someone: before the next signer in a sequential order is invited, on resend, and when a
signing email or a reminder is sent. A refusal is logged and the notification skipped, and
a signer who has already signed keeps that signature. A document created in two steps through
API v1 names an object that the upload URL can write for an hour. At send, the checked PDF is
therefore copied to a key that was never offered for upload and the document's record is
pointed at the copy, so a later upload to the URL changes nothing the document reads. A
document made from a template under S3 or Azure storage took the template's own object as its
original PDF, so for the hour the template's upload URL stayed valid an upload to it changed
the document's original and what a reseal reads; the original bytes are now stored under a
key of the document's own. Two
sends of the same draft at once leave one stored copy, and the one that loses is refused
with a conflict error.

Placeholder fields placed on an envelope item no longer hold database row locks while the PDF
is downloaded and stored. Each request reads the item's current revision, does the PDF and
storage work, and commits only if the item has not moved, so concurrent requests on one item
keep each other's changes or are refused with a conflict error. Objects stored by a failed
attempt are deleted. A field that names no item goes to the first item in order.

Using a template, sending a draft with form values and sealing each stored a document's
bytes in a new row and left the row it replaced behind, attached to nothing; in TerraPay's
own database more than half the stored document rows had been left that way. Each of these
paths now reuses the row or deletes the one it supersedes. A script in `packages/prisma`
reports the rows already left behind and, only when asked, deletes those older than a
cutoff, seven days by default. It deletes rows and never a stored object, because under
S3 or Azure several rows can name the same object. Creating a document through API v1 with
form values also no longer answers 401 after the document has been made.

## Recipient and server security

The client address that audit rows record and rate limits count is read from the
right-hand end of `X-Forwarded-For`, which the trusted proxy writes, rather than from the
left, which the client controls. Access rules are checked on every signing action and not
only when the page loads. An emailed access code locks for an hour after five wrong
attempts, and a document it protects is withheld, with its files, until the code is
entered, on the completion, rejected and expired pages and in the attachment list as well as
on the signing page; without the code, those pages send the recipient to the code prompt and
return once it is entered. The link in the QR code, which every document is given when it is
created, serves the files and the share page only for a completed document that has not been
deleted, and it stays public there because the certificate prints it. An unused query that returned a document's data to a signed-in recipient without
the code is removed. Writes authenticated by a cookie are refused when they come from another
origin, and the job dashboard is no longer exempt from that check. The dashboard is also
read-only: it shows jobs and refuses every request to add, retry, promote, remove, clean,
pause or resume them. A redirect address given for after signing must be an http or https
URL when a document is created through API v1, and the signing pages follow a stored one only
when it is, falling back to the completion page, so a `javascript:` or `data:` address saved
before this check is never followed, nor copied onto a new document from a template or a
duplicate.

Each webhook delivery that has a secret is signed with HMAC-SHA256 over a timestamp and
the body, in `X-TerraPay-Timestamp` and `X-TerraPay-Signature`, so a receiver can check
that the body is the one sent and refuse a replayed one. Webhook delivery connects only to
the address it has just validated, fails closed when the address cannot be resolved, and
caps the response it stores. Every outbound request, to a webhook or to an identity
provider, connects only to the addresses checked when it was validated, so a second DNS
answer cannot redirect it, and the lookup counts against the request's deadline. Request
bodies are capped before anything reads them. API v1 is held to the 10 MiB JSON limit
whatever its content type, the authentication routes to 1 MiB and the job routes to 16 MiB.
A multipart body that may carry several files and declares its length is capped at 64 MiB,
where it allowed ten files at the full single-file limit, a chunked one at the single-file
limit, and the upload screens add up the chosen files first and ask
for them one at a time above 63 MiB. A request refused for its size is answered
with 413 reliably: the server reads and discards a bounded part of the body, limited by
rate and by how many run at once, so the refusal does not reset the connection and slow
senders cannot hold connections open. A request body that arrives too slowly is refused
with 408 whether it is chunked or declares its length: the first byte must arrive within
3 seconds, the body must keep up 32 KiB a second over any 10 seconds, and the whole body
must arrive within 180 seconds, where upstream held such a connection until Node's
300-second request timeout. Chunked bodies read ahead of the route, and bodies that declare
their length, which reserve that length before they are read, may hold 256 MiB in all and
64 MiB for one client, past which the server answers 503. The server keeps an idle
connection open for 65 seconds, so a proxy in front of it that closes idle connections after
60 seconds cannot send a request on one the server is closing. Document files are sent as private and
uncacheable, so no shared cache keeps a copy of a contract. Signing tokens are kept out of logs,
only embedded pages may be framed, and the health endpoint does not publish error detail.
Runtime dependencies with reachable advisories (postcss-selector-parser, proxy-addr,
compression and source-map-js) are patched. A branding stylesheet keeps only colour,
background, border, outline and font properties, where a list of refused properties missed
declarations in nested rules and outside any rule and those written with CSS escapes. Values
are read token by token and only colour and gradient functions survive, border and outline
widths are capped at 16px, 1em or 1rem, and a stylesheet is cleaned again each time a signing
page loads it, so one saved earlier cannot set the position, stacking, transform, size or
margins of the page's controls either.

## Signing pages and staff screens

The button that published a signer's name and signature as a shareable card is removed,
along with the code behind it. "Require account" is not offered as an access rule, because
an external signer cannot hold an account. A document that still has a placeholder
recipient is refused at send. In the version 2 editor a name field shows its
recipient's name and a date field today's date, in the document's format and time zone, laid
out as the signed field will be, so a sender can see whether the value fits; nothing is
stored. A document address under a team that does not exist, or one the user is not in,
shows a not-found page, where it failed with a server error, and the page shown depends on the team alone, never on
whether the document exists. Placeholder addresses use the reserved `.invalid` domain,
and webhooks carry their secret in an `X-TerraPay-Secret` header as well as upstream's
header. Staff who need help are sent to the deployment's own support address, billing code
that could never run here is deleted, and the security settings offer only the options the
deployment supports. Security reports go to TerraPay, as `SECURITY.md` sets out. The
administrators' screens for billing plans, per-plan email transports and the signup
blocklist are removed, since none of them can act on a deployment with no billing, one
sending mailbox and sign-in through Entra alone, and the statistics page names the running
release rather than upstream's version. Every page except an embedded one links to this
repository, which is the offer of source that section 13 of the licence requires. All ten
offered languages are fully translated, and a test fails if any message is left without a
translation.

## Company seals

An organisation can keep several company seals, one for each legal entity, each with a
name, the entity's name and an image. Its managers create them, and a seal cannot be
changed or deleted once saved. A sender places a seal field on a document, which must be a
V2 document, and chooses the seal; only a signed-in member of the organisation, who is the
field's own signer, can apply it. The image is checked and re-encoded when it is uploaded,
and the image applied is copied onto the field, so a sealed document never reads the seal
record again. The audit log names the seal and the legal entity and records the SHA-256 of
the image applied, and the certificate of completion lists each seal applied with its legal
entity and the time. The seal is visual: the document's
digital signature is the deployment's own, as before. The owner's view of a pending document
draws a seal already applied, where it showed the word "Signature", and a seal not yet
applied shows its label. The owner's view receives a seal image only for a viewer in the document's own team, and a
signer's signature pad is never filled in with a seal they have applied.

## Background jobs

The BullMQ library reconnects its worker's blocking connection to Redis with a single
attempt. When that attempt fails, as it can after a short Redis Cluster outage, the worker
stops taking jobs for good while everything else keeps working, so emails, seals and the
scheduled sweeps stop with no error logged. The job provider now watches the worker from
outside the library. Two checks in a row that find a job overdue past a set time, while the
worker has a free slot and nothing such as a pause or a rate limit holds it back, or a
blocking connection that has ended outside a shutdown, make the server log the cause and
shut down gracefully with exit code 1, so that the container platform starts a replacement.

## Archiving to SharePoint

Every completed document is filed to a SharePoint document library, so that executed
contracts are kept where the organisation's retention rules apply. Each file name carries
the document's own identifier, uploads never replace an existing file, an existing file is
accepted as the contract only when its bytes match exactly, and only one run can file a
given document. Filing uses its own application registration and never borrows the
directory's. The health endpoint reports whether filing is working.

## Email through Microsoft Graph

The application sends email through Microsoft Graph as a single mailbox, in place of SMTP
with a username and password. A message too large for one Graph request, such as a
completion email carrying the signed contract, is sent as a draft with its attachments
uploaded separately. The templates' own images travel inside the message as inline
attachments, because mail clients block images fetched from a server until the reader
allows them. A send is recorded only when Graph returns the response it documents
for a successful send, and no Graph request follows a redirect. The signed contract attached
to a completion email is named after the document without a second `.pdf`, which upstream
appended to a title that already ended in one.

## Removal of embedded authoring

Upstream lets an integrator embed its document editor in another site, authorised by a
short-lived presign token minted from an API token. That capability is removed: the embedded
authoring pages and playground, the procedures and API endpoint that mint and verify
presign tokens, and the presign branches of the file routes, which now authenticate by
session alone. Embedded signing for a recipient is kept, and
the version 2 embedded signing page shows the completed state after signing and sends its
completion event to the host page once. The documentation pages for
embedded authoring now say this version does not support it, and the administrator claim
screen lists only the flags an administrator can set.

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

Documenso's colours and fonts are replaced with TerraPay's design system, which also
raises error text, input borders and danger buttons to the contrast WCAG AA asks for, and
the product is called TerraPay Sign throughout. This copy carries upstream's logos and
icons in place of TerraPay's, which are trademarks, and leaves out the TT Firs Neue font
files, which TerraPay licenses and may not redistribute. Anyone building it supplies their
own.

## Testing

The seal job's behaviours are covered by end-to-end specifications. Unit tests accompany each change, in `packages/lib`, `packages/auth` and
`packages/signing`. The end-to-end suite covers the changed flows, and a subset of it can
run against a deployed instance, including a test that creates, signs and seals a document
through the public API. Every Playwright run leaves a manifest of the commit, command and
environment with JUnit and JSON results, and an artifact is kept only after a scan finds no
credential in it. The specifications for protected PDFs, the directory reconcile and the
removed embedded authoring are end-to-end tests written before the code. A signing test
that cut a certificate at its trailing zero bytes, and so failed at random, now cuts it at
its declared length.

## Upstream

Documenso is developed at <https://github.com/documenso/documenso>. Its `README.md`, which
this repository keeps below a short preface, describes the unmodified product and its own
way of running it. Where the README and this file differ about TerraPay Sign, this file is
the record of what TerraPay changed.
