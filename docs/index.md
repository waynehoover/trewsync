# TrewSync documentation

**Self-hosted sync for Obsidian, with an agent inside it.**

[Back to TrewSync](../README.md)

## Start here

- [Is TrewSync right for you?](compared.md): compare hosting, features, and fit.
- [Install with your agent](../llm.md): a runbook for the server, plugin, and verification.
- [Server setup](server.md): run the server and connect your first device.
- [Obsidian plugin](plugin.md): pair devices, check sync, recover notes, and undo an agent's change.
- [Connect an agent](agent.md): the server's MCP endpoint, tokens, and what an agent can and cannot do.
- [Command-line client](client.md): keep a mirror without Obsidian.
- [Security and privacy](security.md): what the server can read, and what protects your notes.

## Run your server

- [Server maintenance](server-operations.md): backups, restoration, monitoring, and purging history.
- [Operating TrewSync](operations.md): `trewd doctor`, a note that seems lost, an agent's run to roll back, and a restore to rehearse.
- [Keep a Git history of your vault](git-export.md): push the vault's history to a private repository, with a deploy key, and replace the Obsidian Git plugin.
- [Server reference](server-reference.md): commands, flags, limits, and health responses.
- [CLI reference](cli-reference.md): every command and flag of the headless client.

## Develop TrewSync

[Developer documentation](development.md) links to the design, protocol,
measurements, and review history. Those pages describe implementation details;
you do not need them to set up or use TrewSync.
