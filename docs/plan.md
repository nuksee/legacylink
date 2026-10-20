# Build plan

Status: draft, awaiting final sign-off (Oct 20, 2026).

Starting point: no code, no Meta Model API access yet. Judging weighs the demo at 25%, so a demo that works every time beats extra features.

## Before Oct 26 (no code)

- [x] Apply to the hackathon (approved Oct 20).
- [x] Get Meta Model API access (account and one API key created Oct 20).
- [ ] Confirm credits on the Billing page and that Muse Spark supports computer use.
- [ ] Read the official rules once they're published.

## 1. Foundation (Oct 26–28)

- Sample order-entry app to target: a web app styled like an old WebForms screen.
- Explorer that maps the app into a screen graph.

Why a web app: Playwright drives it deterministically, and a control can be renamed or moved live for the self-heal demo. A real WinForms app is more authentic but much riskier on stage.

## 2. Learn and compile (Oct 29–31)

- Learn three tasks from one-sentence descriptions: two reads, one write.
- Compile each into a JSON input/output schema, a Playwright script and a post-condition check.
- Serve all three from one MCP server.

## 3. Self-heal and govern (Nov 1–2)

- On a failed post-condition, re-inspect the app and rebuild the script.
- Human approval gate for write actions.
- Run log for audit.

## 4. Harden the demo (Nov 3–4)

- Script the demo: rename and move a control, show the tool break and self-heal.
- Rehearse end to end until it passes every time.
- Record a backup video and write the submission.
- Stretch goals (narrated screen recording via Muse Voice Transcribe, SAM 3.1 grounding) only if all of the above is solid.
