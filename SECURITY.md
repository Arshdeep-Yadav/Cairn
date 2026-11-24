# Security Policy

Cairn is a local-first MCP server and workspace. A vault is a folder of Markdown on the machine that runs it; there is no hosted service, telemetry, or cloud account.

## Supported versions

Security fixes are applied to the latest release only.

| Version | Supported |
| --- | --- |
| 0.1.x (latest) | ✅ |
| < 0.1.0 | ❌ |

Run `cairn --version` to check yours, and `cairn update` to install the latest release.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting for this repository:

**https://github.com/Arshdeep-Yadav/Cairn/security/advisories/new**

Include:

- affected version and platform;
- steps to reproduce, including any config or request needed;
- the impact you demonstrated (for example: session bypass, arbitrary file write, credential leak);
- whether the issue is reachable from a remote browser/client or only from local code.

You should receive an acknowledgement within **3 business days** and a status update within **7 days**. If the report is accepted, we will agree a disclosure date before publishing an advisory or crediting the reporter.

## Scope

In scope:

- authentication, session, CSRF, host/origin and rate-limiting checks in the CLI's local UI server;
- MCP stdio server tool boundaries, note/path handling and redaction;
- the web login/workspace UI (XSS, asset serving, CSP);
- installers, `cairn update`, generated hooks and client config files;
- the `cairn.site` marketing site when it affects this project's users.

Out of scope:

- issues that require root/admin access or arbitrary local code execution on the user's machine;
- vulnerabilities in third-party clients (Claude Code, Cursor, VS Code, etc.) or in npm dependencies — report those upstream;
- placeholder credentials, example passwords and `.test` fixtures in tests/docs;
- theoretical weaknesses without a demonstrable impact;
- denial of service through resource exhaustion on the user's own local vault.

## Operator guidance

- Keep the default loopback bind (`127.0.0.1`). If you publish the workspace, put TLS in front and set `CAIRN_ALLOWED_HOSTS` to your real hostname.
- Use a strong, unique workspace password; rotate it with `cairn auth reset` if it may have been exposed.
- Install only through the official installers or `cairn update`; avoid running unrelated npm packages named `cairn` or `cairn-memory`.
- Treat the vault as private data: it is plain Markdown and is deliberately excluded from capture of `.env` files and binaries.
