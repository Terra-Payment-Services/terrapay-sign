# TerraPay Sign: notice of modification

TerraPay Sign is a modified version of Documenso, the open source document signing
platform, and TerraPay runs it as its internal e-signature service. TerraPay modified the
program, and this version is dated 25 October 2026. This file is the notice that section
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
Signing out answers 200 with an empty body, so the header that deletes the session cookie
reaches the browser. Upstream returned no response once it had ended the session, which the
server reported as an error, and a reply to a session that had already ended now deletes the
cookie as well.

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
An authenticator code is accepted once on the account's own routes, among them those that enable
and disable two-factor and show the recovery codes: each accepted code records its time step, and a code
from that step or an earlier one is then refused, so a code sent twice at once is accepted for
one request alone. That adds a database column, which setting up a new authenticator clears. A recovery code
is removed from the stored list when it is used, including when it is used to show the recovery
codes, and of two requests that use one code at once only one succeeds. Disabling two-factor
checks the code against the authenticator stored when the request is made and clears only that
one, so an authenticator set up and enabled in the meantime is left in place and the request is
refused, as is one that finds two-factor already off, with a client error.

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

An organisation's settings, its subscription and its billing customer are returned only to the
organisation's administrators and managers, and a team's settings, with the organisation's settings
derived into them, only to the team's administrators and managers. The organisation list that every
signed-in page loads carries no settings, and gives the subscription and billing customer to
those roles alone.

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
it read. A PDF may set a page's MediaBox, CropBox and Rotate once on a node of its page tree for
every page beneath it, and the PDF library read them only from the page itself, so such pages
could be sized, cropped or rotated wrongly. A page that inherited its MediaBox was taken as US
Letter, which on an A4 page put sealed fields about 50 points from where the editor showed them,
and the certificate and audit pages appended to the document took the wrong size. The library
patch now walks up the tree for the nearest value, treats a null entry as absent and
stops after 64 levels. The correction is made when a file is read, so it holds for documents
stored before it as well.

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
English. The audit pages appended to a sealed document order entries that share a creation
time, as two written in the same millisecond do, by their id, so those entries appear in the
same order every time the pages are made.

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

Signing a field, removing a signature, completing and rejecting are refused once any recipient
has rejected, including a rejection the owner records on a recipient's behalf through API v2.
Each of these locks the envelope's row and checks again under the lock, so a rejection and any of
them run one after the other and the later one sees the earlier. Under the same lock, completion reads the
recipient's fields again and writes its automatic date values, so a refused completion leaves its
automatic date fields and completion state unchanged. An assistant's write to a field is refused once that field's recipient has signed, and
when one field of a legacy (V1) document is signed twice at once, one request succeeds and the
other is refused. Each of
these refusals is answered with a client error, where several failed with a server error.

A rejection fixes the document's outcome, though the document stays pending until the seal job
records it. In that time the owner cannot edit or delete a recipient who has rejected, nor one
who has filled in any field, whatever their role, and cannot change, move or remove that
recipient's fields. Each of the owner's edits checks again under the envelope's lock, so a
rejection or a signature that commits first is seen rather than overwritten, and a field submitted
under a recipient it does not belong to is refused. An administrator's edit of a recipient is
written only while the recipient has neither signed nor rejected, so one who does either at the
same moment is not edited. A rejected document cannot be cancelled. The
owner's delete hides it, as it hides a completed document, and sends no deletion emails, and an
administrator's purge tells the recipients that a document was cancelled only when nobody had
rejected it, and only once the purge has committed. An invitation is suppressed when a check finds a rejection:
sending, resending and the invitation of the next signer in a sequential order each look for a
rejection on the primary database, and again just before the email goes, and the next signer is
chosen and written under the lock, so a name and address the previous signer dictates cannot
overwrite a rejecter. A recipient whose role was changed to CC after rejecting keeps the
rejection, and the seal records it.

A cancelled document is never sealed, resealed or announced as complete, whoever queued the job,
and an administrator cannot reseal one. The seal writes the document's final status only if the
status is still the one it read when it started, and does so first in its commit, so a seal and
a cancel that run at once leave one outcome: a cancel that commits first makes the seal discard
the copies it made, and one that comes second is refused. A send that loses to a cancel is
refused in the same way. Every recipient action waiting on the envelope's lock checks once it
holds it that the document is still pending. A seal job whose document has been purged ends
without retrying, and a stored file whose database row cannot be created is deleted. Where read
replicas are configured, the checks for a rejection read the primary, since a replica may not yet
hold the latest commit, and the seal looks its document up on the primary when a replica does not
find it, before it treats the document as purged. Of two requests that sign one
field of a version 2 document at once, the later is refused, as on version 1; checkboxes and
radio buttons, which the signing page edits in place, keep the later value. On a version 2
document, completion writes each automatic date value only to a date field that is still empty
under the lock, so a date the recipient filled in while the completion waited keeps its value
and gets no second audit entry. API v1 answers 400,
where it answered 500, when it refuses to resend a rejected document.

Changing a recipient's email address to a different one gives the recipient a new signing link
and marks the document unopened for them, whether the owner, an administrator or the previous
signer dictating the next one makes the change, so the link sent to the old address stops working:
every signing action checks under the envelope's lock that its link is still the recipient's. An
address that differs only in letter case keeps the link. An administrator's edit of a recipient is
taken under the same lock as the owner's, cannot change the address of a recipient who has filled
in a field, and is recorded in the document's audit log with the values it changed. When it changes
the address, the recipient counts as not yet sent the document, as on the owner's edits, unless
they are a CC.

Once a document is completed, rejected or cancelled, or a recipient has rejected it, its settings
stay as they are: the subject, message, date format, time zone, redirect address, signing order, dictation of
the next signer, reply-to address, email settings, distribution method, signature methods and
language, its access and action authentication, and legacy field insertion. A request that repeats
the stored values passes. The check is made under the envelope's lock, so a completion or a
rejection that commits first is seen, and the folder, visibility and external id may still change.
Access and action authentication are written only when a request names them, and their audit
entries compare with the values read under the lock.

A signed-in user who uses a direct template signs as their own account. The address they give
must be their account's, compared without letter case or surrounding spaces, or the request is
refused with a client error, and the audit entries carry the account's id.

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
form values also no longer answers 401 after the document has been made. Adding a recipient
through API v1 adds that one recipient. It used to delete and recreate every recipient already on
the document, which gave each of them a new signing link, deleted their fields and, on a sent
document, could email them that they had been removed.

## Signature values and signing order

Every route that stores a signature checks the value on the server: signing a field of either
document version, a direct template, account creation and the profile. Upstream stored any
non-empty string. A typed signature is trimmed, must contain a letter, number,
punctuation mark or symbol, may contain no control character anywhere and is at most 500
characters. A value that starts with `data:`, in any letter case, is an image and must be a PNG
data URL in canonical base64, at most 4 MiB decoded and 4,096 pixels on each side; it is decoded,
checked for ink and stored re-encoded as an 8-bit RGBA PNG, so every later reader sees the bytes
that were checked. A pixel counts as ink when, laid over white, its luminance is below 230 of 255,
and an image needs ink on more than 1% of its pixels. The signature pad applies the same rule,
where it counted every pixel that was not fully transparent, so a white or faint drawing or upload
is refused in the browser and on the server alike. A saved signature that fails the rule is not
offered on the signing pages or in the profile form, and saving the profile form while it is
held back clears it. The upload pad stores only the part of the pad the image covers, so an uploaded
signature keeps its own shape and fills its field rather than carrying the pad's empty margins,
and the drawing pad no longer starts a stroke from the press that opened it.

The signature methods a document allows, typed, drawn and uploaded, are enforced when a field is
signed through either version's route, and checked again under the envelope's lock, so a change
to them that commits first applies. Upstream refused only a typed signature where typing was
off, and accepted an image with drawing and uploading both off. A drawn image and an uploaded
one cannot be told apart, so an image is accepted when either is allowed. Settings that leave all
three off are refused when an organisation's, a team's, a document's or a template's settings
are saved and when a document or a template is created, directly or from a template, and API v1
answers that refusal with 400.
The check reads the stored settings under row locks taken in one order, so two saves at once
cannot together turn every method off for an organisation or for any team that inherits from it.
A document already stored with all three off is signed as if all three were on, and its signature
pad offers all three, where it showed nothing.

The seal, the certificate and the partial download draw each signature from a PNG re-encoded from
the stored image within the same limit of 4,096 pixels a side, never from the stored string,
which the PDF library may not read. When a stored image cannot be read at all, the seal stops
before it changes the document's status or its PDF: a pending document stays pending and a
resealed one keeps its status and PDF, its CC recipients that have not rejected are marked as
signed as on every seal attempt, its audit log gets one entry for each such field, saying
that the signature image could not be rendered and the document was not sealed, and the job is
not retried. The downloads answer such an image with a client error. The rejection email to the
rejecter and the cancellation emails to the other recipients are sent by the seal that first
takes a rejected document out of pending, where upstream sent them at the moment of rejection, so a
seal that stops sends none and a later reseal sends none again. A request for the certificate of
a document that is not complete is answered with a client error rather than a server error.

In a sequential signing order the server enforces each recipient's turn when a field is signed or
cleared, a document completed or rejected, an assistant's actions included, and checks it under
the envelope's lock, so a completion or a reorder that commits first is seen. Upstream checked the
order on the signing page and at completion alone, before the lock, and a signer's link
could sign or clear a field, or reject, out of turn by calling those routes directly. Recipients who share a position in the order form a step and may act in
any order among themselves; the next step opens once all of them have signed. On an advanced or
qualified (AES or QES) document the members of one step still go one at a time, by id. Sending a
document invites every member of the first step, or on such a document its first member, and of two completions that run at once only the
one that opens the next step invites its members, each once. A signer may dictate the next
signer's name and address only when the next step has a single recipient. The version 1 signing
routes refuse a field of a version 2 document, which the version 2 route checks under its own
rules. Embedded multi-sign refuses a version 2 document, and a recipient whose turn has not come,
before it shows the document or records it as viewed. A signed-in visitor outside the document's
team who opens a signing link before their turn sees the waiting page, where it failed with an
error.

Once a recipient other than a CC has signed, rejected or filled in a field of a pending document,
the document cannot be switched from parallel to sequential signing or back. In a pending
sequential document, the owner's edits of the recipients cannot move a recipient whose turn has come
or passed, nor make one a CC, and cannot place any other recipient at or ahead of the step whose
turn it is; only a new CC, or a recipient who is a CC and stays one, may sit anywhere. These rules
are checked under the envelope's lock against the positions that will be written. An owner's request
that names one recipient twice is refused, and API v1 answers a signing-order refusal when it adds a
recipient with 400, where it answered 500. The version 2 editor keeps the
stored positions on such a document and places a new signer after the last one, or with no
position where a stored signer has none.

A free-signature field can be signed only on a legacy (V1) document. It is refused on a version 2
document or template wherever fields arrive: when the envelope is created, from placeholders in an
uploaded PDF, when a file is added or replaced, and when fields are created, set or updated, and the
refusal comes before any file is stored. On a legacy document a free-signature field asks for the
document's action authentication, as a signature field does.

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
origin, and the job dashboard is no longer exempt from that check. The session cookie is
SameSite=Lax: the browser still sends it when a link on another site opens a Sign page, but
withholds it from other requests that site starts, including those of a page embedded there.
An embedded signing page that needs the recipient to be signed in to their account therefore
no longer works on another site, while one that relies on the signing link or an emailed
access code still does, because the access code cookie stays SameSite=None and partitioned. The dashboard is also
read-only: it shows jobs and refuses every request to add, retry, promote, remove, clean,
pause or resume them. A redirect address given for after signing must be an http or https
URL when a document is created through API v1. No signing page follows it of its own accord: after
signing, and on opening the link again, the recipient lands on the completion page, which shows the
address and its host with a Continue link that sends no referrer. The link is offered only to a
recipient other than a CC who has signed, while the document is not deleted and the recipient's link
has not expired, and only for an http or https address, so a `javascript:` or `data:` address saved
before this check is never offered, nor copied onto a new document from a template or a duplicate.

Where a document or
a recipient requires the recipient's own account, which the editor does not offer but the API
accepts, the document's files and downloads, its attachment list and its list of items, as served to
a signing link, check that requirement as the signing page does, together with the access code; on
a direct template's link it means any signed-in user. The embedded legacy signing page reads a rule
set on the recipient as well as one set on the document. Until the access code is entered, the page
that asks for it receives nothing of the recipient beyond the signing link and the address the code
was sent to, and none of the document's authentication settings. An access code
counts only for the signing link it was entered under, so a recipient whose link changes enters a
code again. A recipient who asks for more access code emails than the rate limit allows is answered
429, where the answer was 500, and the prompt asks them to wait a few minutes; a limit that refuses
a request sets its own rate-limit headers on the answer. A passkey, authenticator code or password
asked for on a signing action proves the recipient only when the signed-in account's address is the
recipient's. Where a recipient's access rule is not met, the rejected page names them by email
address alone.

A request that fails validation on the authentication routes or on the file and download routes is
answered 400 with the path of each field at fault and the message "Invalid value", never with the
values submitted. An unexpected server error raised in a tRPC procedure, whether it is called
by the app or through API v2, is answered with "Something went wrong" and a request id, without
its original message or stack trace, and the server log records the detail under the same id. API v2 answers a request whose body is not JSON,
URL-encoded or multipart with 415, and a failure inside its request handling with 415 or 500, each
with a JSON body. It reads a supported content type in any letter case, passes a URL-encoded body to
its procedures as JSON, and ignores the content type of a GET, HEAD or OPTIONS request; the library that serves it is patched to the same end, and installing the
dependencies fails if any patch in `patches/` does not apply. A failure to close the browser after
generating a certificate or audit log PDF no longer stops the server. A Brand Website, set in organisation
or team branding, must be empty or an absolute http or https address whose host is made of dotted
ASCII labels, the last starting with a letter, with an optional port, and which holds no whitespace,
invisible or control character, backslash or user name; the branding form says why it refuses one,
and emails link the address only when it passes the same rule.

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
background, border colour, outline colour and font properties, where a list of refused properties missed
declarations in nested rules and outside any rule and those written with CSS escapes. Values
are read token by token and only colour and gradient functions survive. A tenant can recolour a
border or outline the app already draws (`border-color`, the four `border-*-color` properties
and `outline-color`) but cannot create, widen, restyle or round one: the `border` and `outline`
shorthands, every style and width property and the radius properties are removed with a
warning, since borders on nested elements add up and can erase an icon, as 3px borders on a
checkbox and its tick did, and a rounded corner shows what lies behind an element. A
`font-family` is kept only when every family in it is on a named list: the generic `serif`,
`sans-serif`, `monospace`, `system-ui`, `ui-sans-serif`, `ui-serif` and `ui-monospace`, and
Arial, Helvetica, Helvetica Neue, Verdana, Tahoma, Trebuchet MS, Segoe UI, Roboto, Inter, Open
Sans, Lato, Georgia, Times New Roman, Times, Garamond, Palatino, Courier New, Courier, Consolas,
Menlo and Monaco, compared without letter case. Families are split at the commas as written, a
quoted name is always a font name, and any backslash removes the value, since an escape can
join two families into one name or hide a comma; a single unquoted `inherit`, `initial`,
`unset`, `revert` or `revert-layer` is kept too, and a quoted one is a font name and removed.
A quoted Arial broken across lines with a backslash is removed as well, though the browser would
read it as Arial. Any other family, `fantasy`
and `cursive` included, removes the declaration with a warning, so a symbol font such as
Wingdings cannot turn a label into pictures. A stylesheet is cleaned again each time a signing
page loads it, so one saved earlier cannot set the position, stacking, transform, size or
margins of the page's controls either. Colours alone could still hide a label, so text and icon
colours are checked against their background at 3:1, in both the light and dark themes, when
branding is saved and again each time a signing page loads it. A rule's own colours are paired
with each other, and a colour set without its partner is paired with the page's background or
text colour. The colour tokens are checked in their pairs too: background with foreground and
with muted foreground, and muted, popover, card, field card, primary, secondary, accent and
destructive each with their foreground, and the input colour, which draws form-field and
checkbox borders, with the background. The signing components also put the foreground and the
muted foreground on the card (the mobile signing widget) and on the widget (the desktop
widget), the muted foreground on the popover, the popover and secondary foregrounds on muted,
and the primary and destructive colours on the background (the field loading spinners and the
rejected page's icon), and those pairs are
checked as well, each traced to the component line that paints it. A few surfaces have a fixed
background rather than a token: in the light theme the V2 signing page and the neutral alert
paint `bg-gray-50` (#f6f7f7), so the foreground and the muted foreground are checked against
that colour too, the muted foreground at 80% opacity as the PDF page label paints it. In the dark theme that
label sits on the page background instead, so the muted foreground is also checked at 80% on the
background there, and a palette with light text tokens is refused at save rather than falling
back on the signing page. An unreadable token pair refuses the save, an unreadable
stylesheet pair is removed with a warning, and a colour the check cannot read counts as
unreadable. The branding settings page shows why a save was refused, where it showed a generic
error. Emails, which have no dark theme, use the default colour for each token in a pair below
3:1, checked against each other and against the light defaults, as the signing page does. Gradients are not evaluated, so a text colour set with a gradient background is
removed. A tenant background must be proven opaque: a `background-color`, `background` or
`background-image` colour, gradient stops included, is kept only when the check reads it and its
alpha is 1. One it cannot read, such as `color-mix()`, `hwb()`, `lab()`, a system colour or a
relative colour, and one with alpha below 1 or written as `transparent`, `currentcolor`,
`inherit`, `initial`, `unset`, `revert` or `revert-layer`, is removed with a warning when saved
and when a page loads it, before the contrast check, so the rule's other declarations are judged
as if it had never been written. A `background` shorthand that paints no colour, such as
`background: none`, is removed too. The guard reads only an element's ancestors, so app paint
behind them, such as the overlay behind a dialog, is invisible to it. Three rules keep a tenant
from exposing that paint: backgrounds must be opaque, the radius properties
(`border-radius` and the four corner properties) are refused, since a rounded corner clips an
element's opaque background and shows what lies behind it, and the radius colour-token field,
which sets every rounded corner in the app, is held to `0`, a `px` length up to 16px or a `rem`
length up to 1rem. A larger radius, or one in `%`, `em`, `pt` or a bare number, is refused when
saved and dropped when a stored row or an embed renders, so the default radius applies. A
dialog rounds its corners with the radius itself (`rounded-lg`), so at most 16px, against padding
of at least 16px (`packages/ui/primitives/dialog.tsx:64`). Text colours may still be
translucent, since they are read against the background beneath them. A branding stylesheet may be at most 32,768 characters; a longer one is
refused when saved, and a longer row stored before the limit was lowered renders without its
CSS while its colours and logo still apply. That limit is the real bound on what a stylesheet
can cost. Inside it, a scan of the text before it is parsed is a second layer: a stylesheet is
refused whole when saved, and dropped when a page loads it, if it holds a control character
other than tab, line feed, carriage return or form feed, nests rules more than eight levels
deep, or holds more than 10,000 statements (the `;` and `{` outside strings and comments, plus
each comment), more than 20,000 characters of selectors and at-rule conditions, or more than
2,000 simple selectors. Comments do not count toward the selector characters. A rule selector
the scan measures at over 1,000 characters, edge whitespace aside, is left out of them, since
the sanitiser normally drops it before parsing it; a selector the scan misreads is not
necessarily dropped. The scan is a second layer and not exact, and some unusual constructions can
mislead it. The 32,768-character limit bounds what
such a stylesheet costs, at about 50 ms and 55 MiB on each render-cache miss. A legacy property hack
such as `*background` is removed. The
check has a fixed budget of 5,000 declarations and 200,000 comparisons for each stylesheet, and
past it the remaining rules lose their colours. A colour value or colour token longer than 1,000
characters counts as unreadable, and a colour token left blank is not rendered. A rule is
removed before its selector is parsed when the selector is over 1,000 characters or has more
than 50 compound selectors, counted as CSS reads them, so brackets, quoted strings, escapes and
the arguments of `:is()` and `:not()` add none. Each check returns at most 500 warnings and a
count of the rest. A signing page caches the checked stylesheet for each stored stylesheet and
colour set, up to 200 of them and 16 MiB per server process, and reuses the result while it
is resident in the process cache rather than redoing the work on every page load. These are limits on this check, not a guarantee about
every other cost of a large stylesheet. The save-time check cannot see every way separate rules of a stylesheet combine in the browser.
The signing page therefore guards
the stylesheet as the browser applies it, and so that the guard never has to watch a state a tenant
rule depends on, a selector may name no state at all. Each selector is checked on its raw text, as
stored and together with anything written between it and its `{`, before any parser reads it, when the stylesheet is saved and when a page loads a
stored one. It may contain only ASCII letters and digits, space, tab, line feed, carriage return
and `- _ . # [ ] = ~ ^ $ * " ' , > + :`, so every escape, every parenthesised form such as
`:is()` or `:not()`, comments, namespaces, `|=` and every non-ASCII character are refused; and
once every `::placeholder`, in any letter case, is removed, no colon may remain. So no
pseudo-class of any kind is kept, `:hover`, `:focus` and the structural ones included, and
`::placeholder` is the one pseudo-element. A colon inside a quoted attribute value, as in
`[href^="https:"]`, is refused too: that costs a tenant a selector it could write safely, and is
accepted to keep the rule a check on characters. A refused selector drops its rule with a
warning and the rest of the stylesheet is kept. The universal selector `*` stays refused, and a
`;` in a selector still makes the whole stylesheet a parse error.
The tenant stylesheet sits in its own element, apart
from the colour tokens. The page applies it and, in the same task, measures what the signer
reads: the text colour of every visible element with text of its own, the text and placeholder
of every text box, and the fill and stroke of icons inside buttons, links and tabs, each against
its background, found by compositing each ancestor's background colour over white, apart from
elements inside an icon, whose backgrounds the browser never paints. A control that shows no text,
value, placeholder or icon, such as an unchecked checkbox, is judged by its boundary, as WCAG 2.2
success criterion 1.4.11 asks for non-text contrast: its border, on a side that paints, or its
own background must reach 3:1 against the background behind it, or read no worse than it does in
the default theme, with no margin, so a border made transparent, or painted to match what
surrounds it, fails even where the default border is faint. A control that draws no boundary in
the default theme at all, such as a transparent click overlay, is not judged by its boundary.
Every visible, enabled text box, text area and select is also judged by its boundary
whatever it holds, so a filled name field or a typed rejection reason keeps its border. An icon shape's fill is
measured only where it paints: a shape that encloses no area, such as the lines of an X, at no
point of a 7 by 7 grid inside its box, kept off the box's edges (where the browser reports an
open line's endpoints as inside its fill), is not judged on a fill nobody sees. An element with an opacity
below 1, or inside one, is painted as the browser paints it: the faded group is composited at
that opacity over what lies beneath it, so the dialog close button, drawn at 70% opacity, is
measured on the colour it shows. The default
theme has placeholders and muted icons below 3:1 of its own, so an element below 3:1 is measured
again in the default theme, with the stylesheet and the colour tokens switched off and the logo
kept, in the same task with transitions paused, and its text counts against the branding only
when the branding makes it more than 0.3 worse than the default theme does. A tenant rule cannot change with hover or focus, but the app's own state styles
can. Since a tenant can no longer write a hover rule, the stylesheet is nested in the wrapper
class repeated three times, `.documenso-branded.documenso-branded.documenso-branded`, so a
tenant `button` rule weighs 0,3,1 and beats the app's state classes, such as
`.hover\:bg-accent:hover` and `.hover\:bg-secondary\/80:hover` (0,2,0, from
`packages/ui/primitives/button.tsx` lines 18 to 20) and the `group-hover:` forms (0,3,0). A
colour the tenant sets therefore holds in every state; without the repeat, a dark theme with
near-white button text read 1.29:1 on a hovered Cancel button, on the app's light hover
background, and the guard disabled it. The colour tokens keep the single class. A tenant who
sets only one of a control's two colours still meets the app's state colour for the other, so
a hovered app control can pair an app colour with a tenant one. The page therefore
measures again as a whole, at most once a frame, whenever its content changes, such as a dialog
opening; whenever hover or focus starts or ends anywhere (`pointerover`, `pointerout`, `focusin`,
`focusout`); when a pointer button or a key goes down or up (`pointerdown`, `pointerup`,
`keydown`, `keyup`), for the app's `active:` and `focus-visible:` styles; when the signer types
(`input`); and when a transition ends. A `pointermove` event itself schedules nothing. A scan takes
about 3 ms for 500 elements and 30 ms for 5,000. An element in a colour or opacity transition or animation, or inside
one, is measured once it finishes, so a dialog's entrance fade is judged at its settled
opacity. The page also measures at once when one of the stylesheet's media conditions, print media or the colour scheme changes, or the
window is resized; and before printing, with the stylesheet's print rules applied to a copy. If
anything fails, the whole stylesheet is disabled for the rest of the visit, its print copy with
it, and the page is measured again, so a failing print rule does not count against the tokens. If anything still fails, the colour tokens are disabled as well, which the
save-time pairs cannot always prevent, since text colour is inherited and a text token can land on
a background token no pair names. The page then shows the default theme with the tenant's logo.
The guard runs whenever a page has a stylesheet or colour tokens, and measures again when a token
style element changes. There is no limit on how often the page scans: a stylesheet can no
longer restyle anything on hover, so the guard has no hover loop to stop. Where it can, the signing page
checks a stylesheet as it applies it. A broad `button` rule can pass when the page loads and be
switched off once the signature dialog opens, because the dialog's muted labels, such as the
pen colour and "Upload Signature", sit on buttons the rule repaints. The admin who saved the
stylesheet is not warned at save time that the guard will disable it, in that case or any other. A visible, enabled text box is measured on its own text colour whether
or not it holds a value, and on its placeholder while empty, so a value a script writes needs no
event to be checked. These checks reduce, and do not remove, the chance that branding leaves text
unreadable; what remains is an insider risk, open to a team or organisation admin. A listed font
name is still resolved on the signer's device, so a device whose font of that name is something
else shows that instead.

## Signing pages and staff screens

The button that published a signer's name and signature as a shareable card is removed,
along with the code behind it. "Require account" is not offered as an access rule, because
an external signer cannot hold an account. A document that still has a placeholder
recipient is refused at send. In the version 2 editor a name field shows its
recipient's name and a date field today's date, in the document's format and time zone, laid
out as the signed field will be, so a sender can see whether the value fits; nothing is
stored. Undoing strokes on the signature drawing pad checks the drawing that remains, as drawing
does, and clears a signature that no longer passes. The version 2 editor's send dialog
takes the subject, message, reply-to address and distribution method from the saved settings
each time it opens. It used to keep what it first opened with, send that and save it over later
changes. Its controls stay disabled while it waits for an editor save still in flight. A
document address under a team that does not exist, or one the user is not in,
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
repository, which is the offer of source that section 13 of the licence requires. The app
offers English and ten translated languages. Tests fail if a message in the source is missing from
any catalog, if an entry is left without a translation, or if a catalog holds a raw control
character or a merge conflict marker, which the French message for a removed attachment showed in
place of its translation until this version.

When a team's "Send on Behalf of Team" setting is off, set on the team or inherited from its
organisation, recipients are shown the team in place of the member who sent the document, with the team's
email address where the message or page shows one. Upstream applied the setting to the
invitation and to part of the signing page's data; it now covers the places that follow. A
reminder's heading and default message now name the team, the version 1 signing page
shows the team where it had the condition inverted, and the data sent to the signing,
completion, embedded and direct-template pages carries the team in place of the owner. The cancellation, deletion, recipient-removed and rejection-confirmation emails
name the team too. In the audit pages appended to a sealed PDF the owner card shows the team,
and the team stands in for every team member an entry names, among them the member a rejection
was made on behalf of and a delegated owner, and for whoever recorded a rejection on a
recipient's behalf. A team member who is also a recipient keeps their name on what they do as a
recipient. The audit log in the
application and the owner's own audit-log download still name the members. With the setting off, signing, resend and
reminder emails also leave out the header that carries the sending member's user id; the headers that
carry the envelope and team ids remain.

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

The upstream features below, which called third parties, are removed; webhook delivery,
described above, remains. An optional feature sent an
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
