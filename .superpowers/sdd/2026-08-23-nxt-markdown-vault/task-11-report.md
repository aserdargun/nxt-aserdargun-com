# Task 11 Report — Editor, Preview, Drafts, and Conflict Recovery

## Outcome

Task 11 is implemented in commit `d5a19f2`.

The real `/app/notes/:noteId` route now mounts a Gruvbox CodeMirror Markdown editor, sanitized preview, immediate IndexedDB drafts, one-second autosave, exact server readback confirmation, and a fail-closed three-option version-conflict workflow.

## Test-driven implementation

- Initial focused RED: all three new suites failed only because the production editor modules did not yet exist; the pre-existing 45 web tests passed.
- Focused GREEN before final edge-case hardening: 81/81 tests.
- Final focused GREEN after malformed-response and recovered-title fixes: 83/83 tests.
- Previously completed full live-unset run: 502 passed and one opt-in live Drive test skipped (contracts 11, domain 19, API 391, web 81).
- Final source passed lint, monorepo typecheck, production build, and project contract checks before a redundant sequential full run stalled in the API Vitest process. That duplicate run was terminated after more than 16 minutes; no failure was reported, and no new full run was started.

## Load-bearing behavior covered

- Draft writes are persisted locally before network save scheduling.
- Autosave waits exactly 1,000 ms and fences stale responses across rapid edits, in-flight requests, note changes, and unmounts.
- `Saved` is shown only after GET readback confirms the note identity, source, checksum, version, and path.
- Network/offline failures retain the local draft and expose the exact `Offline draft` or `Error` state.
- A 409 fetches the latest Drive version and opens a conflict dialog without overwriting by default.
- The dialog offers exactly `Keep Drive version`, `Save local as a new note`, and `Merge versions`; recovery-copy failures retain local work for retry.
- Recovered copies use `Recovered <UTC timestamp>` and the injected current opaque folder identifier.
- Malformed local drafts and malformed server responses fail closed.
- Markdown preview uses the shared sanitized domain renderer; raw HTML is not executed, wiki navigation stays in-app, and only canonical application attachment routes are accepted.
- Pinned dependencies: `@uiw/react-codemirror@4.25.11`, `@codemirror/lang-markdown@6.5.2`, and `idb@8.0.3`.

## Browser and visual QA

The production preview was exercised through the guarded loopback session. A temporary same-origin browser harness intercepted only the note GET/PUT/POST endpoints; no production bypass was added.

- Desktop editor/preview: 1505×1045, concurrent source and preview, zero horizontal overflow.
- Mobile editor and preview: 390×844, single active surface, zero horizontal overflow, 67 px navigation targets, 16 px CodeMirror text.
- Desktop conflict: 900×676 dialog, equal 449 px panels, 44 px action buttons, initial focus on `Merge versions`.
- Mobile conflict: 366×820, vertically stacked panels, 332×44 px actions, zero horizontal overflow.
- All four captured images were inspected at original resolution against the accepted Task 10 shell and Task 11 conflict concept.

Artifacts:

- `artifacts/task-11-desktop-1505x1045.png`
- `artifacts/task-11-mobile-editor-390x844.png`
- `artifacts/task-11-mobile-preview-390x844.png`
- `artifacts/task-11-conflict-1505x1045.png`

## Hygiene and boundaries

- `web/tsconfig.tsbuildinfo` was restored to the Task 10 baseline.
- Ports 5173 and 5174 are closed.
- No Google Drive credentials, live Drive integration, GitHub, Azure, DNS, deployment, or other external mutable state was accessed.
- The worktree was clean immediately after the implementation commit.

