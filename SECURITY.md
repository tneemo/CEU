# Security

CEU is experimental software for a single user on a trusted local computer.
There is no account system or API authentication. The server binds to
`127.0.0.1` by default, checks local Host/Origin headers, and locks its data
directory before recovery. These checks are not authentication. Do not expose
it through a public bind address, reverse proxy, or tunnel.

## Data and credentials

- Conversations, attachments, memory, provider settings **and provider API keys**
  are stored in `data/` (or `CEU_DATA_DIR`). Provider keys are plaintext in SQLite;
  API responses hide them, but database copies remain sensitive.
- GitHub tokens use Windows Credential Manager or the OS keyring. External
  runtimes keep their own login state, separately from CEU provider keys.
- Requests send prompts and relevant context to the selected provider. Local
  storage does not mean local inference. Automatic titles and starter suggestions
  can make additional model requests and incur API charges.
- Keep data directories outside shared/synced folders when appropriate.
  Stop CEU before a file-level backup; copy the entire data directory.
- Never commit databases, `.env`, logs, tokens, or runtime credentials. Revoke
  exposed credentials; deleting a file does not remove it from Git history.

## Execution boundaries

Code commands run with the permissions of the host user. Manual approvals help
review actions but do not sandbox shell commands. Undo covers CEU-tracked file
edits, not arbitrary shell side effects, network operations, or external harnesses.

Chat code execution optionally provisions a separate Ubuntu WSL2 distro on
Windows. It downloads a root filesystem and packages on first use. Network access
is always enabled; network blocking is not implemented. WSL2 reduces accidents
and is not a hardened boundary for hostile code. External runtimes have their own
permission and sandbox policies. See [runtime notes](docs/runtimes-code.md).

## Reporting

Once public, use GitHub private vulnerability reporting or a private security
advisory if enabled. Otherwise open an issue requesting a private contact
**without** posting secrets, conversation data, or exploit instructions.
No dedicated private reporting endpoint or response SLA exists yet.
