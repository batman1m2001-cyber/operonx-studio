# Must-have UX: sign in with Google, the assistant's Claude sign-in where it is needed, edit an op like n8n

**Status:** 2026-10-14. U2 was already built (found when starting it). U3 (c) done; (a) and (b) next; U1 waits for an OAuth client.

## Why

The user asked for UI/UX improvements that are must-have, not over-engineered, and gave three examples:
- sign in with Gmail;
- sign the assistant in with a claude.ai login;
- change an op's settings in the Flow view, the way n8n's node panel works, without drag and drop.

Each was checked against the code as it is today. Two of the three are partly built already. The gap is that people cannot find them, or they stop short of the ops that matter most.

## The items

### U1. Sign in with Google

**Now:** username and password only (`users.sqlite`). An admin creates each account and hands over a temporary password.

**Proposal: Google's device sign-in.** It works the way the assistant's Claude sign-in does: a link and a code, with no fixed address needed.
1. The sign-in page gets **Sign in with Google** above the password form.
2. A click shows Google's link (`google.com/device`) and a short code.
3. The person opens the link themselves, signs in with their Google account and types the code.
4. The studio asks Google every few seconds until the sign-in is done, then logs them in.

Who may sign in, and with which role:
- An admin adds a person by their email address and picks their role as today.
- That person's first Google sign-in links the address to the account.
- A Google account nobody added is refused, with "ask an admin to add you".
- Passwords stay as the fallback: the first admin, a machine with no internet, and the tests.
- The users table gains an `email` column. Roles, sessions and the per-person Claude sign-in are unchanged.

**Why the device sign-in:** the usual "redirect back to the site" sign-in only returns to a URL registered in advance. The localhost.run links change on every reconnect (five times in two days), so every new link would break it. The device sign-in never comes back to the studio: the studio asks Google instead. So the tunnel can change freely.

**What it needs from you:** a Google OAuth client of the type **"TVs and Limited Input devices"**, created in Google Cloud (free, a couple of minutes). It asks only for `openid` and `email`. Its client id and secret go in the studio's `.env`.

**Size:** small to medium:
- one call to start the sign-in, a poll until it finishes, and a check of Google's signed ID token;
- a link to an existing user by email;
- the sign-in page's box with the link and the code.

### U2. The assistant signs in with Claude where it is used

**Now:** this is built. Each person signs the assistant in with their own claude.ai account:
- the studio runs `claude auth login` in that person's own Claude directory;
- the page shows the sign-in link and takes back the code;
- the token never leaves that directory.

**Correction (found when starting U2):** the plan said it lived only in Settings. It does not. The assistant panel already does everything proposed here:
- signed out, the panel shows its own **Sign in with Claude** card when the page loads (`assistant.js`, on load);
- a reply that fails for want of a sign-in brings the card back, and an error card offers **Sign in**;
- the usage popover at the composer's foot shows the account, with **Switch account** and **Sign out**.

**Proposal:** none. It is built.

### U3. Edit an op in the Flow view, like n8n's node panel (no drag and drop)

**Now:** half built. Selecting an op opens Inspect, which already edits:
- the op's call arguments (`configure.js`);
- its `@op(...)` options;
- the resource it uses.

Every change is shown as a diff first, written into the code safely (`safewrite.py`), and can be undone. What it does not cover:

- **(a) Agents.** An agent's settings live in its `Agent(...)` declaration, not in the call, so none of them can be changed in the studio:
  - its instructions;
  - its model;
  - each tool's policy (allow, ask or deny; this completes backlog B1 of the merge plan, where the card only shows the policy);
  - whether it keeps memory.

  Proposal: Inspect edits these on the selected agent, with the same diff-first, undoable write.
- **(b) Trying the change.** n8n's core loop is: change a setting, run that one node, see the new output. The studio can only run the whole flow from the Playground.

  Proposal: **Run this op** re-runs the selected op on the input it last recorded, and shows the new output beside the last one. Ops that call outside services (an LLM, a TTS) say so before they run.
- **(c) The panel's order.** n8n reads left to right: what the node got, its settings, what it gave.

  Proposal: Inspect shows an op in that order, top to bottom: **Input** (last recorded), **Settings** (editable), **Output** (last, or the new one after Run this op). Only the order changes; each part already exists somewhere in the studio.

**Size:** (c) small, (a) medium, (b) medium.

**(c) done:** a new endpoint returns an op's last recorded execution from its graph's newest runs (`/api/p/{pid}/op/{op}/last`). Inspect shows **Input** (with a link to that run), the settings, then **Output**.

**Not proposed:** dragging or moving anything; adding, deleting or rewiring ops on the canvas. The flow stays code-first, and the assistant writes new ops.

## Order

1. **U2**, the assistant's sign-in where it is used: small, and the assistant is useless to anyone who cannot find it.
2. **U3**, edit an op like n8n, in three PRs: (c) the panel's order, (a) agents, (b) Run this op.
3. **U1**, Google sign-in, once the OAuth client exists.

Each PR is checked on the callbot, meeting-prep and meeting-prep-brd, on desktop and phone, in light and dark.

## Considered and left out

- **Drag and drop, free placement, editing wires.** Asked against, and the layout is automatic.
- **Other sign-in providers** (GitHub, Microsoft, generic SSO). Google covers the team. The flow, once built, takes another provider in an afternoon if one is ever asked for.
- **Editing services and jobs** (door path, port, schedule) from the studio. They change rarely, and a wrong port takes a service down. The code, or the assistant, is the safer place.
