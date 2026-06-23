# SERVARI Handoff - Chat/Voice UI Route-Scoped Fix

Date: 2026-06-10
Repo: `H:\servari-open-live`
Owner: ALFRED (for APEX PRIME handoff)

## Scope Completed
- Fixed duplicate/competing chat UI behavior in Electron/desktop shell.
- Reworked chat access to be route-aware.
  - `/shell` keeps mini chat behavior and chat toggle.
  - `/shell/chat` runs chat as dedicated route stage and disables mini chat bubble so no duplicate window-like UI appears.
- Preserved mic-only control in chat route.
- Built and verified fresh artifacts to keep release flow ready.

## What I changed
- File: `ui/src/app/components/Shell.tsx`
  - Removed local in-shell chat state `isChatOpen` and local `<ChatPanel />` mounting.
  - Removed standalone floating chat button that opened local chat panel.
  - Reworked layout to anchor the main stage with `marginLeft: dockWidth` instead of `marginRight` shift tied to chat panel.
  - Added `useNavigate` and route detection:
    - `isChatRoute = location.pathname === "/shell/chat"`
  - `Ctrl+K` now navigates to `/shell/chat` instead of toggling shell chat state.
  - Passed route flag into global voice: `<GlobalVoice showMiniChat={!isChatRoute} />`

- File: `ui/src/app/components/GlobalVoice.tsx`
  - Added `showMiniChat?: boolean` prop.
  - Chat polling and refresh now execute only when mini chat is enabled.
  - `startConversation` and interim transcript no longer force-open mini chat when route disables it.
  - `chatPanelVisible` is now gated by `showMiniChat`.
  - Mini chat toggle button now conditionally renders only when `showMiniChat` is true.

## Why these choices
- Route scoping removes two competing chat containers.
- Desktop real estate issue from duplicate controls is fixed by making one chat UX path active at a time.
- Keyboard behavior stays coherent:
  - `Ctrl+Shift+F` opens Focus mode.
  - `Ctrl+K` opens the chat route.
- `ChatPanel` remains available via route mount where it belongs.

## Verification completed
- UI production build:
  - Ran `npm run build` from `H:\servari-open-live\ui` (success).
- Electron portable build:
  - Ran `npm run build:exe` from `H:\servari-open-live` (success).
  - Output artifact:
    - `H:\servari-open-live\dist-exe\SERVARI-x64.exe`
    - Size: `372256798` bytes
    - Timestamp: `2026-06-10 20:41:31`

## Files changed
- `ui/src/app/components/Shell.tsx`
- `ui/src/app/components/GlobalVoice.tsx`

## Current git state (worktree)
- `M ui/src/app/components/Shell.tsx`
- `M ui/src/app/components/GlobalVoice.tsx`
- `?? server-run-8999.err`
- `?? server-run.err`

## Notes for APEX PRIME
- `ChatPanel.tsx` still exists and is still used by the `/shell/chat` route.
- Route split now behaves as:
  - `/shell`: floating mini chat + mic controls.
  - `/shell/chat`: chat route stage + mic only.
- Existing chat features are preserved; only activation surface changed to avoid duplicate overlays.

## Suggested next actions
- Add release notes and screenshots for both `/shell` and `/shell/chat`.
- Keep `dist-exe\SERVARI-x64.exe` as the prepared release artifact.
- Perform tag/release publication when you are ready to publish externally.
