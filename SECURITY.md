# Security

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. We aim to answer within a week.

Never include a real KanbanFlow API token in a report, issue or pull request. If one was exposed, revoke it in KanbanFlow (board menu → Settings → API & Webhooks) and create a new one.

## How this server handles your data

- **Read-only.** No tool can create, change or delete anything on a board.
- **Tokens stay local.** API tokens are read from the MCP client's configuration (environment variables), sent only to the KanbanFlow API over HTTPS, and never written to responses or logs. A failing token is reported by its position in the list, not by its value.
- **Board data goes to your AI provider.** Tool results (task names, descriptions, member names…) are passed to the model your MCP client uses. Only configure boards whose content you are allowed to share with that provider.
- **Task text is untrusted.** Anyone with access to a board can write task names and descriptions. They reach the model as data; a description could try to steer the model ("prompt injection"). This server cannot act on the board, but be careful when the same client also has tools that can send messages or change data.
- **API quota.** KanbanFlow allows 1000 requests per hour per board and may lock a token after 5000 in a day. Loading complete "done" columns costs many requests; avoid doing it in loops.

## Supported versions

Only the latest published version receives fixes.
