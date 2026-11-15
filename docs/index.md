# TrewSync documentation

**Self-hosted sync for Obsidian that keeps every version and has MCP built in.**

[Back to TrewSync](../README.md)

## Start here

- [Is TrewSync right for you?](compared.md): how it compares, and when another sync fits better.
- [Server setup](server.md): run the server and pair your first device.
- [Install with your agent](../llm.md): a runbook an agent follows to set everything up.
- [Obsidian plugin](plugin.md): pair devices, check sync, recover notes, and undo an agent's change.
- [Connect an agent](agent.md): the MCP endpoint, tokens, and what an agent can and cannot do.
- [Command-line client](client.md): keep a copy of your vault without Obsidian.
- [Security and privacy](security.md): what the server can read, and what protects your notes.

## Run your server

- [Server maintenance](server-operations.md): back up, restore, monitor, and purge history.
- [Operating TrewSync](operations.md): `trewd doctor`, finding a note that seems lost, rolling back an agent's run, and rehearsing a restore.
- [Keep a Git history of your vault](git-export.md): push the vault's history to a private repository, and replace the Obsidian Git plugin.
- [Server reference](server-reference.md): commands, flags, limits, and health responses.
- [CLI reference](cli-reference.md): every command and flag of the headless client.

## Develop TrewSync

[Developer documentation](development.md) covers the design, protocol,
measurements, and review history. You do not need it to set up or use
TrewSync.
