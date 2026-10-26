# LegacyLink

An agent that learns tasks in API-less legacy apps and compiles them into typed, self-healing MCP tools.

Built for the Meta Global AI Developer Hackathon (Indie track, Oct 26 – Nov 4, 2026).

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

Building. Done so far: the screen graph format, the explorer ([docs/explorer.md](docs/explorer.md)), the learner ([docs/learner.md](docs/learner.md)), and the compiler, runner, MCP server and approval console ([docs/compiler.md](docs/compiler.md)). Next: self-heal.

```sh
npm install
LEGACYLINK_PASSWORD=demo npm run legacylink -- explore --url http://localhost:5080 --user demo
npm run legacylink -- learn "Get the status of a sales order by its order number"
npm run legacylink -- compile --examples examples/contoso/examples.json --user demo
npm run legacylink -- serve      # MCP over stdio; approve writes at http://127.0.0.1:5180
npm test
```
