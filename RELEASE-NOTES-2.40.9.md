# BLACKICE 2.40.9

Candidate source notes, not an installation or publication receipt.

- **Personal Context** is an on-demand skill for finding relevant prior decisions and durable preferences, checking provenance, and returning to current evidence. A previous Goal, deadline, or assistant report is not current authority. The skill respects Past Chats and does not import older chat text automatically.
- **Directory Diagnostics** restores an opt-in Directory outline for inspecting what a turn was given, attached tools, observed action receipts, and recorded stop state. It is local and task-scoped. It never supplies context to the model or enables the retired execution machinery. Older turns may have only partial evidence. A receipt cannot show what the model thought or how it used particular context.
- **Previous-turn diagnostics** lets a model request bounded host evidence about its actual parent turn, without opening access to other chats. Provider-native cumulative usage is separate from last-provider-turn usage; neither demonstrates the reason for a stop by itself.
- **New task in this chat** starts a separate execution and Goal lineage while keeping an accessible group of related tasks. Existing per-task history and archive state stay separate.

The latest candidate does not include a live employer application or claim that a model will choose the right action merely because a skill is discoverable. See [Directory in Chat](docs/directory-chat-mode.md) for evidence limits.
