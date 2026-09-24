# Security policy

## Reporting a problem

Report a vulnerability privately, through GitHub's
[private vulnerability reporting](https://github.com/waynehoover/trew/security/advisories/new)
for this repository. Do not open a public issue for it. If private reporting is
unavailable to you, open an issue that asks for a private contact and says
nothing about the problem itself.

Include what you did, what happened, what you expected, and the versions of
the server (`trewd version`), the plugin and the command-line client
(`trew --version`) involved. A reproduction is the most useful thing you can
send. Never include a real token, invite, device credential or note you do not
want read.

This is a one-maintainer project. Reports are read and answered as soon as
they can be, and a fix ships in a new release of the affected component, with
the report credited unless you ask otherwise.

## What counts

TrewSync's design and its limits are written down in
[Security and privacy](docs/security.md), the
[design](docs/design.md#threat-model-the-server-is-trusted) and the
[threat model](docs/threat-model.md). A problem is anything that breaks a
property those pages claim. For example:

- A device, invite or MCP token that works after it was revoked, expired or
  used, or a way to connect without one.
- A read token that changes a note, or any token that reaches something outside
  the vault's notes, such as `.obsidian`.
- Note content, a path, a token or an invite appearing in a log, a metric, the
  unauthenticated `/health` response, or anywhere else it should not.
- Note-derived text reaching an MCP result outside `untrusted_content`.
- A way to make TrewSync lose or corrupt a note, or report a write as durable
  that is not. Data loss is treated as a security problem here.

What is **not** a vulnerability, because it is the design and the docs say so:
the server can read every note; anyone with the server's disk or a backup can
read the vault; a token reads the whole vault and what the agent reads reaches
its model provider; devices trust the server's word about content and
authorship; a paired device is trusted with every note.

## Supported versions

Fixes go into the newest release of each component. There are no maintained
older branches; upgrade to the newest server first, then the clients.
