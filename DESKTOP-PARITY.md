# Zedu Desktop — parity map

> Living reference for the auto-work loop. Web = `zeduchat/zedu-fe` (Next.js
> client). Desktop = `zeduchat/zedu-desktop` (Flutter). Status is a starting
> point; verify in code before filing or fixing.

| Area | Web behaviour | Desktop today | Status | Notes |
|---|---|---|---|---|
| Auth | login, signup, magic link, Google, forgot password, 2FA | auth feature present | partial | Verify 2FA, magic-link retry, Google callback |
| DMs | list, conversation, send, attachments, reactions, threads/replies, pin, mute, clear, search, files, copy, edit/delete, drafts | dms feature present | partial | Known gaps: View files, Clear history, Pin/mute persistence, search raw HTML, drafts height |
| Channels | directory, create/edit, members, settings, export, pin, search, threads | channels feature present | partial | Known gaps: create from directory, empty/error states, hidden/archived filter |
| Buzz / calls | start, join, participants, screen share, record | mock Agora token in `buzz_repository.dart` | mock | Replace mock token with the real call API |
| Notifications | panel, settings, unread badges, push | partial | partial | Known gap: panel always says "You're all caught up" |
| Search | global, conversation | partial | partial | Search input, clear button, backend search |
| Files | browse, preview, upload, folders | partial | partial | Download/preview, folder support |
| Profile / account | edit, avatar, country, timezone, password, status | user_profile feature present | partial | Known gaps: avatar upload, country selector, timezone, save-before-close |
| Organization | members, roles/permissions, invites, user management | organization + user_profile | partial | Known gaps: mock members, hard-coded org, roles source |
| Billing / credits | plans, invoices, credits | credits feature present | partial | Known gaps: hardcoded prices, stale credits |
| Workspaces | switch, settings | workspaces feature present | partial | Known gap: fabricated workspaces before load / after failure |
| Settings | appearance, notifications, security, sessions | partial | partial | Known gap: missing Appearance settings vs web |
| Calls | Agora, participants, hand raise | mock | mock | Needs real backend integration |
| Cross-platform | n/a | Linux/macOS/Windows | partial | Linux keyring spinner, system tray, window sizing, keyboard shortcuts |

## Priority order

1. Remove mocks that make features lie (Agora, fake members, hardcoded prices).
2. Fix data-loss / persistence bugs (pin/mute, clear history, drafts, session expiry).
3. Complete core chat flows (threads, files, search, notifications).
4. Cross-platform correctness (Linux keyring, tray, window sizing).
5. Visual polish and design-system alignment.
