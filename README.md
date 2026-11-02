# LegacyLink

**Give AI agents a safe, typed API to apps that never had one.** LegacyLink watches an API-less legacy app, learns a task from one sentence, and compiles it into a typed, self-healing MCP tool that any agent can call. Meta's Muse Spark does the learning and the healing; the compiled tools run without a model.

Built for the Meta Global AI Developer Hackathon (Indie track, problem statement **Push the Frontier**, Oct 26 – Nov 4, 2026); see [what was built during the hackathon](#built-during-the-hackathon).

**Try the target app:** [Contoso Order Entry](https://contoso-order-entry.vercel.app/) (log in as demo / demo), the fake legacy app LegacyLink is demoed against ([source](https://github.com/nuksee/contoso-order-entry)). The hosted copy runs in your browser and keeps its data there, so it's for clicking around; the demo runs against a local copy (`--contoso`), which LegacyLink can reset and drift.

## The problem

AI agents are only as useful as the systems they can reach, and they reach systems through APIs. A lot of real work still happens in apps that have none: the order-entry screen, the ERP form, the WebForms or WinForms tool a vendor stopped updating years ago. People re-key data into them all day.

Large companies can pay for a rewrite or a robotic process automation (RPA) team. Small and mid-sized businesses usually can't, so the one app their business runs on becomes the place where AI stops. And the usual workaround, screen-scraping scripts and RPA bots, breaks the first time the vendor renames a field or moves a button.

## Who benefits

- **Small and mid-sized businesses** with a line-of-business app they can't replace: their staff and their AI assistants can use it through tools instead of copy and paste, without a rewrite.
- **Agent builders**, who get typed MCP tools with input and output schemas instead of a raw browser, so an agent can call "create a sales order" the way it calls any API.
- **IT and operations teams**, who keep control: writes wait for a person to approve them, every run is logged, and a vendor patch doesn't mean rewriting the automation.

## How it works

1. **Explore.** LegacyLink crawls the app and maps it into a screen graph: screens, controls, and the edges between them. It never presses Save, Submit or Delete while exploring, so it's safe to point at a real app.
2. **Learn.** Muse Spark turns one sentence ("Get the status of a sales order by its order number") into a path through the graph with typed inputs and outputs.
3. **Compile.** The task becomes a tool spec: a JSON Schema for inputs and outputs, a deterministic Playwright step list, a post-condition that proves the run worked, and an MCP endpoint. The compiler proves each tool with a verify run before registering it.
4. **Run.** A compiled tool runs with no model call, so it's fast, cheap and gives the same result every time.
5. **Self-heal.** When a vendor patch renames or moves a control and a run fails, Muse Spark looks at the screen as it is now and picks the replacement control. LegacyLink patches the tool, re-runs the call, and keeps the patch as the tool's next version only if the post-condition passes.
6. **Govern.** A write fills the form, then stops before the commit button until a person approves it in a local console, with a screenshot of exactly what will be saved. Every run, heal and approval goes to an append-only run log.

## How Muse Spark is used

Muse Spark (`muse-spark-1.3` through the Meta Model API) makes the decisions that need judgment, and nothing else. Details: [docs/explorer.md](docs/explorer.md#model-modes), [docs/learner.md](docs/learner.md), [docs/healer.md](docs/healer.md).

- **Learning a task from one sentence.** The learner gives Muse Spark the screen graph and the sentence. It answers with a learned task (screen path, which controls are inputs, which elements are outputs, the commit step and the draft schemas) as schema-constrained JSON. LegacyLink checks that every screen, control and edge it names exists, and sends the errors back once if not.
- **Healing with vision.** When a control disappears, Muse Spark gets the missing control's name, intent, old caption and locators, the unclaimed elements on the page, and a screenshot. It answers with the element it thinks replaced the old one and a one-line reason, for example "Order #" became "Sales Order No.". That reason is shown in the console and in the MCP result.
- **Exploring (optional).** With `--explore-model live`, Muse Spark names each screen and control and picks what to try next. The demo uses the rule-based explorer by default because it's faster and its graph is the one the tools were tested on.

What makes this more than a chat call:

- **The model writes data, never code.** Every answer is JSON validated against a schema. Muse Spark picks a candidate element; it never writes a locator or a script, and nothing it returns is `eval`ed.
- **Its answers are checked by rules it can't override.** A heal for a text field must land on an input, and a Save click can only land on something that looks like a commit button, so a heal can never make a read press Save or point Save at Delete. A refused answer goes back to the model once with the reason.
- **The model is out of the hot path.** Muse Spark is called when a tool is learned or breaks, not on every run. A healthy tool is pure Playwright.
- **Every answer is recorded.** Live answers are saved in a model cache and can be replayed byte for byte. [examples/contoso/model-cache/](examples/contoso/model-cache/) holds real Muse Spark answers recorded on 2026-10-26 for the demo's learn calls and every heal, so the demo can run on stage with no network and still show Muse Spark's own reasons.
- **It fails safe.** If a live call fails or an answer fails validation twice, a rule-based stand-in decides instead, and the console says which one did.

## Engineering

- **Typed tools.** Tool specs and learned tasks have JSON Schemas ([src/formats/](src/formats/)), checked with Ajv at every hand-off. MCP clients see real `inputSchema` and `outputSchema`.
- **Every run proves itself.** A tool succeeds only when its post-condition passes. "No exception was thrown" is not success.
- **Versioned self-heal.** A heal changes only the broken controls' locators. It writes `version + 1` with `provenance.healedFrom`, registers it only after a passing retry, updates the screen graph, and sends MCP clients `notifications/tools/list_changed`. A rejected or failed retry keeps the old version. More than 5 heals of one tool in an hour marks it broken instead of looping.
- **Write safety.** The runner finds the commit button before asking for approval, so a renamed Save heals before anyone is asked. A write that failed at or after its commit step is never retried, because the record may already be saved. A healed write's approval card is flagged "Changed since last approval" and lists what changed.
- **Audit trail.** An append-only run log with screenshots of every run, heal and approval, shown in the local console.
- **Reproducible demo.** `legacylink demo` runs the whole pipeline in one command, and `--repeat N` rehearses it from a clean state each time, failing any run where a heal fell back to the stand-in.
- **Tested.** Unit and end-to-end tests run in CI against a fixture app, including a read and a write healing through MCP, a rejected heal keeping v1, and drift after a commit not being retried ([test/](test/)).

Design and formats: [docs/architecture.md](docs/architecture.md). Component docs: [explorer](docs/explorer.md), [learner](docs/learner.md), [compiler, runner and MCP server](docs/compiler.md), [healer](docs/healer.md), [demo runbook](docs/demo.md).

## Run the demo

You need Node 20 or later. Check out Contoso next to this repo:

```sh
git clone https://github.com/nuksee/legacylink && git clone https://github.com/nuksee/contoso-order-entry
cd legacylink && npm ci && npx playwright install chromium

# the whole demo in one command: explore, learn 3 tools, compile, serve over MCP,
# two reads, a write that waits for Approve at http://127.0.0.1:5180,
# then a "vendor patch" renames and moves controls and the tools heal
npm run legacylink -- demo --contoso ../contoso-order-entry --headed --pause
```

By default the demo replays the recorded Muse Spark answers, so it needs no API key. Pass `--model live` with `MODEL_API_KEY` set to call Muse Spark, or `--model live --fresh` to call it for every learn and heal. Rehearse with `--repeat 10`. More in the [demo runbook](docs/demo.md).

Each step on its own:

```sh
LEGACYLINK_PASSWORD=demo npm run legacylink -- explore --url http://localhost:5080 --user demo
npm run legacylink -- learn "Get the status of a sales order by its order number"
npm run legacylink -- compile --examples examples/contoso/examples.json --user demo
npm run legacylink -- serve      # MCP over stdio; approve writes at http://127.0.0.1:5180
npm test
```

To use the tools from Claude Desktop or another MCP client, see [docs/compiler.md](docs/compiler.md#mcp-client-config).

## Status and limits

Working end to end against Contoso: three compiled tools (two reads and one write behind the approval gate), rename and move drift healed live, in replay and live model modes. Reads have also been called from Claude Desktop as a real MCP client; the write and a heal through Claude Desktop haven't been tried yet (the scripted demo drives both through the MCP SDK's stdio client).

Not done yet: real WinForms, Citrix or terminal apps (the runner drives web pages through Playwright), navigation changes beyond renamed or moved controls, and multi-user approval.

## Built during the hackathon

Everything in this repo was built during the build window (Oct 26 – Nov 4, 2026) except the following, which date from Oct 20 (see the git history: the build window starts at tag [`hackathon-start`](https://github.com/nuksee/legacylink/releases/tag/hackathon-start), commit `b1d5ccf`):

- `docs/plan.md` and `docs/architecture.md` (the design and format spec, with no code), plus an earlier version of this README.
- `.claude/`: Claude Code dev tooling, including two skills copied from [anthropics/skills](https://github.com/anthropics/skills) under Apache 2.0. These are not part of the product.
- The demo target, [contoso-order-entry](https://github.com/nuksee/contoso-order-entry). It's a fake legacy app made as a test fixture, and isn't part of the entry.

The full breakdown is in [docs/hackathon.md](docs/hackathon.md#what-was-built-when).
