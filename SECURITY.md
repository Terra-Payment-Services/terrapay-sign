# Security Policy

TerraPay Sign is TerraPay's fork of Documenso, used to sign legally binding documents. This policy covers this fork. Report anything you find here to TerraPay, not to the Documenso project.

## Reporting a Vulnerability

Report security vulnerabilities privately, through either channel:

1. **Email** to [security@terrapay.com](mailto:security@terrapay.com).
2. **GitHub private vulnerability reporting**, using the [report form](https://github.com/Terra-Payment-Services/terrapay-sign/security/advisories/new) on the public mirror.

Do not open a public issue, discussion or pull request for a security report.

Include the affected version or commit, a clear description, steps to reproduce and the impact you expect. If the issue also affects upstream Documenso, say so; we will coordinate with the Documenso maintainers rather than ask you to report twice.

## Scope

In scope is the application code in this repository, including everything TerraPay changed or added. That includes the areas upstream treats as operator concerns, because this fork changed them:

- Sign-in through Microsoft Entra, account linking and session handling
- Access to documents, envelopes and files across users, teams and recipients
- Presign and recipient tokens
- Server-side request forgery, DNS rebinding and other outbound request handling
- Webhook delivery and signing
- Document sealing, signatures, timestamps and the audit trail
- Rate limiting where the application enforces it

Out of scope are findings that depend on a deployment someone else has misconfigured, and volumetric denial of service.

If you are unsure whether something is in scope, report it privately anyway.

## Supported Versions

Security fixes go into the latest release. Only the latest release is supported.
