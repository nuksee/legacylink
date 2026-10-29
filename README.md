# LegacyLink

An agent that learns tasks in API-less legacy apps and compiles them into typed, self-healing MCP tools.

Built for the Meta Global AI Developer Hackathon (Indie track, Oct 26 – Nov 4, 2026).

## Built during the hackathon

Everything in this repo was built during the build window (Oct 26 – Nov 4, 2026) except the following, which date from Oct 20 (see the git history):

- `docs/plan.md` and `docs/architecture.md` (the design and format spec, with no code), plus an earlier version of this README.
- `.claude/`: Claude Code dev tooling, including two skills copied from [anthropics/skills](https://github.com/anthropics/skills) under Apache 2.0. These are not part of the product.
- The demo target, [contoso-order-entry](https://github.com/nuksee/contoso-order-entry). It's a fake legacy app made as a test fixture, and isn't part of the entry.

The full breakdown is in [docs/hackathon.md](docs/hackathon.md#what-was-built-when).

## The problem

Enterprises still run legacy apps with no API (WinForms, WebForms, Citrix-published apps, terminal emulators), and people re-key data into them all day.

## How it works

1. **Explore.** A Muse Spark computer-use agent explores a legacy app and maps it into a screen graph.
2. **Learn.** It learns a task from a one-sentence description.
3. **Compile.** The task becomes a typed tool: a JSON input/output schema, a deterministic Playwright script, a post-condition check, and an MCP endpoint any agent can call.
4. **Run.** Compiled scripts run without the LLM, so they're fast and cheap.
5. **Self-heal.** When a script fails its post-condition, the agent re-inspects the app and rebuilds the script.
6. **Govern.** Write actions need human approval, and every run is logged for audit.

## Status

Building. Done so far: the screen graph format, the explorer ([docs/explorer.md](docs/explorer.md)), the learner ([docs/learner.md](docs/learner.md)), the compiler, runner, MCP server and approval console ([docs/compiler.md](docs/compiler.md)), self-heal ([docs/healer.md](docs/healer.md)), and the scripted end-to-end demo with its runbook ([docs/demo.md](docs/demo.md)).

```sh
npm install
LEGACYLINK_PASSWORD=demo npm run legacylink -- explore --url http://localhost:5080 --user demo
npm run legacylink -- learn "Get the status of a sales order by its order number"
npm run legacylink -- compile --examples examples/contoso/examples.json --user demo
npm run legacylink -- serve      # MCP over stdio; approve writes at http://127.0.0.1:5180
npm test

# the whole demo in one command (Contoso checked out next to this repo)
npm run legacylink -- demo --contoso ../contoso-order-entry
```
