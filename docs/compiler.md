# Compiler, runner and MCP server

These turn learned tasks into tools an MCP client can call. The compiler writes a tool spec ([architecture.md](architecture.md#format-2-the-tool-spec)) for each task and proves it with a verify run. The runner executes specs with Playwright. The MCP server lists the registered tools and sends calls to the runner, and a write waits in the approval gate until someone answers it in the console. Nothing on the run path calls a model.

## Run it

```sh
# Contoso running locally (npm start in nuksee/contoso-order-entry), tasks in .legacylink/tasks/
export LEGACYLINK_PASSWORD=demo
npm run legacylink -- compile --examples examples/contoso/examples.json --user demo
npm run legacylink -- run get_order_status '{"orderNumber":"SO-10042"}'
npm run legacylink -- serve          # MCP over stdio; console on http://127.0.0.1:5180
```

`compile` reads `<out>/tasks/*.json` (or the files you name), compiles the reads before the write, and registers each tool in `<out>/tools/`. It also writes `<out>/config.json` with the app URL, the login form's locators and the user name. The password isn't stored anywhere: it's read from the variable named in the config (`--password-env`, `LEGACYLINK_PASSWORD` by default). A write's verify run saves a real record, so `compile` asks on the terminal first. Use `--approve` to skip the question.

`--examples` maps each tool name to the input for its verify run. [examples/contoso/examples.json](../examples/contoso/examples.json) has the inputs for the demo.

To use the checked-in tools without compiling, copy `examples/contoso/{graph.json,config.json,tools}` into `.legacylink/`.

### MCP client config

```json
{
  "mcpServers": {
    "legacylink": {
      "command": "npx",
      "args": ["tsx", "/path/to/legacylink/src/cli.ts", "serve", "--out", "/path/to/.legacylink"],
      "env": { "LEGACYLINK_PASSWORD": "demo" }
    }
  }
}
```

A write call stays open until someone approves it or the 5-minute timeout runs out. If the client sends a `progressToken`, the server sends a progress notification every 10 seconds, which stops clients that support `resetTimeoutOnProgress` from timing out. A client with a short fixed timeout can still give up first, so open the console before the demo and approve right away.

## What compile does

1. **Draft** ([src/compiler/compile.ts](../src/compiler/compile.ts), deterministic). It copies each element's ranked locators and intent from the graph. `open` becomes `goto`. A click that follows an edge to another screen gets a `waitForScreen` step. A grid link becomes `clickRow` on the screen's grid. Row elements such as `product$line` get one set of locators, with `$line` where the row number goes (`ctl00_MainContent_ddlProduct$line`). It then derives:
   - **Post-conditions.** A read must end on the expected screen, and an output with the same name as an input must echo it (`customerId`, `orderNumber`). A write must produce its required outputs and pass a `readBack`: it's re-read with a registered read tool that takes one of its outputs as input, so `create_sales_order` is checked with `get_order_status`. The readBack compares every simple input the read tool returns. An input that only matches the start of a field name is compared as a prefix, so `customerId` C1003 matches `customer` "C1003 - Adventure Works".
   - **Error rules.** Any visible `role="alert"` after a click is the app saying no, such as a validation summary, "not found" or a credit limit. The run ends as `app_error` with the app's own text and never counts as drift.
2. **Verify run** ([src/compiler/verify.ts](../src/compiler/verify.ts)). The draft runs once with the example input. A write stops at the approval gate, commits, and only then looks for its result: an output step after the commit has no locators yet, so the runner picks the visible element whose id best matches the output's name and intent (`orderNumber` → `ctl00_MainContent_lblOrderNumber`). Only a passing run is registered.

Muse Spark isn't called at compile time yet. The learned task already holds every decision the model makes, and finding the result element works without a model on Contoso. If a model is needed there later, `pickDiscovered` in [src/runner/run.ts](../src/runner/run.ts) is the place to add it.

## The runner

[src/runner/run.ts](../src/runner/run.ts). One `Session` has one browser, one logged-in context and one page, and runs one tool at a time. It handles these Contoso quirks:

- Every click waits for the postback or navigation to finish, then for `load`.
- A `goto` that lands on the login page logs in and retries, so an expired session recovers.
- `-` and empty values count as absent: the field is left out of the output. `parse: "money"` turns `$7,500.00` into `7500`.
- An optional input the caller leaves out (`poNumber`) skips its fill.
- `clickRow` finds the row by its column caption and cell text. A missing column counts as drift (`locator_failed`). No matching row, or several, is the app's answer (`app_error` with `not_found` or `ambiguous`).

### Outcomes

| Outcome | Meaning | Heal? |
| --- | --- | --- |
| `ok` | steps ran, error rules quiet, post-condition and output schema passed | no |
| `app_error` | the app refused (alert text, or no matching row) | never |
| `rejected` / `approval_timeout` | nobody approved the write; the browser leaves the form unsaved | no |
| `failed` + `reason: locator_failed` | a target matched nothing with every locator, or the wrong screen loaded; `error.step` and `error.key` name the step | yes, when a control is named ([healer.md](healer.md)) |
| `failed` + `reason: postcondition_failed` | the steps ran but the result didn't prove itself | yes, if a control on the screen is gone ([healer.md](healer.md)) |
| `failed` + `invalid_input` / `app_unreachable` / `failed` | bad input, app down, anything else | no |

The healer starts from these fields ([healer.md](healer.md)). The `step` events in the run log also record `matchedLocator`, so a step that fell back to a lower-ranked locator shows up before anything breaks. Against Contoso, Move drift passes with no heal, and Rename fails with `locator_failed` on `customerId` (New Order) and `orderNumber` (Order Status) until the healer fixes them (see [test/contoso.test.ts](../test/contoso.test.ts)).

## Approval gate and console

[src/approval/gate.ts](../src/approval/gate.ts), [src/console/console.ts](../src/console/console.ts). Before the commit click, the runner checks that the commit button can be found, then takes a full-page screenshot of the filled form and opens a request. The console at `http://127.0.0.1:5180` shows each pending request with its input and screenshot, plus Approve and Reject buttons, the tool list and the run log. A request is flagged "changed since last approval" when the tool's current version isn't the one last approved, which is what a heal will produce.

Only the console can decide, and the MCP server has no tool for it. The console listens on 127.0.0.1 only. Decisions need an `X-LegacyLink` header, which a page on another site can't send without a CORS preflight that this server never answers. Requests with another `Host` are refused, which blocks DNS rebinding.

## Files

```
.legacylink/
  config.json                    # app URL, login locators, user name, password variable name
  tasks/<tool>.json              # from the learner
  tools/<tool>@<version>.json    # tool specs
  tools/registry.json            # current version, status, last approved version
  runs/<date>.jsonl              # run_started, step, approval_*, run_finished
  artifacts/<runId>/approval.png # the form a person approved or rejected
  artifacts/<runId>/failure.png
```

## Tests

- [test/compiler.test.ts](../test/compiler.test.ts) compiles the Contoso tasks without a browser and checks that the checked-in specs in [examples/contoso/tools/](../examples/contoso/tools/) are still what the compiler produces.
- [test/runner.test.ts](../test/runner.test.ts) runs the whole pipeline on the fixture app: explore, learn, compile, then MCP calls through an in-memory client, covering approval, a forged approval request, reject and app errors.
- [test/contoso.test.ts](../test/contoso.test.ts) runs against a real Contoso when `CONTOSO_URL` is set (`CONTOSO_URL=http://localhost:5080 npm test`). It resets the app's data before and after.
