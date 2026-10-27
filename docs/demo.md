# Demo runbook

The live demo is one command. `legacylink demo` resets Contoso Order Entry, explores it, learns the three tasks from one sentence each, compiles them into MCP tools, starts the MCP server and calls the tools from an MCP client: two reads, then a write that waits for approval in the console. Then it turns on Contoso's Rename + Move drift (a "vendor patch") and calls again, and the tools heal in front of the audience. Code: [src/demo/demo.ts](../src/demo/demo.ts).

Each stage runs the real CLI (`explore`, `learn`, `compile`, `serve`) in a child process, so the audience sees the same output as the other docs. The MCP client is the SDK's stdio client, the same transport Claude Desktop or MCP Inspector uses.

## Before the demo (once)

```sh
git clone https://github.com/nuksee/legacylink && git clone https://github.com/nuksee/contoso-order-entry
cd legacylink && npm ci && npx playwright install chromium
```

Rehearse with the repeat harness until it's boring (below). Record the backup video from a passing run.

## The demo

Two terminals, or one with `--contoso`, which starts Contoso if it isn't running and stops it at the end.

```sh
cd legacylink
npm run legacylink -- demo --contoso ../contoso-order-entry --headed --pause
```

- `--headed` shows the browser, so the audience watches LegacyLink drive the app.
- `--pause` waits for Enter before each act, so you can talk over it.
- Without `--auto-approve` the two writes wait for you: open http://127.0.0.1:5180 and press **Approve**. The second one is flagged "Changed since last approval" and lists what the heal changed. A request expires after 5 minutes.
- The password is Contoso's demo login (`demo`) unless `LEGACYLINK_PASSWORD` is set.

What happens, act by act (about 30 seconds without pauses):

| Act | What the audience sees |
| --- | --- |
| Reset Contoso | seed data, drift off; `.legacylink/` is wiped except `model-cache/` |
| Explore | 6 screens, 36 edges; nothing is ever saved |
| Learn ×3 | one sentence each becomes `get_customer_details`, `get_order_status`, `create_sales_order` |
| Compile | each tool runs once against the app and is registered; the write's verify run saves one order |
| Serve | the MCP client connects and lists the three tools at v1; the console URL is printed |
| Read ×2 | Adventure Works with its credit limit; SO-10042 Backordered |
| Write | `create_sales_order` fills the form, waits for **Approve** in the console, saves, reads the order back |
| Vendor patch | Contoso renames Customer # → Account No., Order # → Sales Order No., Save Order → Submit Order, Look Up → Find, and moves the buttons |
| Read after drift | `get_order_status` breaks, heals (`[heal]` lines, console "Self-heals" panel, a `[LegacyLink self-heal]` line in the MCP result) and returns the new order; the client gets `tools/list_changed` and sees v2 |
| Write after drift | `create_sales_order` heals before it asks, the approval card lists the heal, saves after **Approve** |

The command ends with a timing table and exit code 0 only if every check passed. Drift is turned off again at the end (`--keep-drift` leaves it on).

## Model: one switch

Muse Spark makes the model decisions in learn and heal. The demo's default is **replay**: the live Muse Spark answers recorded in [examples/contoso/model-cache/](../examples/contoso/model-cache/) (2026-10-26) for the three learn calls and every heal in the demo, copied into `.legacylink/model-cache/` at the start of each run. Same answers every time, no network, and the `[heal]` lines and console still say `muse-spark-1.3` with its reasons.

| Setting | Learn and heal answers come from |
| --- | --- |
| nothing (default) | `replay`: recorded Muse Spark answers. Use this on stage. |
| `--model live` or `LEGACYLINK_MODEL=live` | Muse Spark, called now. Needs `MODEL_API_KEY` (or a proxy that adds the key). New answers are recorded too, and `.legacylink/model-cache/` survives every demo run. |
| `--model heuristic` | the rule-based stand-in. No model at all; the last resort. |

The explorer has no recordings and a live exploration takes about two minutes, so `explore` uses the rule-based explorer unless you pass `--explore-model live`. Its graph is the one the tools were tested on.

In replay and live, the repeat harness fails a run if a heal fell back to the stand-in (a missed recording or a failed call), so a rehearsal can't pass on the stand-in by accident. On stage the demo carries on with the stand-in's heal and prints a `!!` line.

Replay needs the screens to look exactly as they did when recorded. Contoso prints its business date on the home page, so `--contoso` starts it with `BUSINESS_DATE=2026-11-04`; if you start Contoso yourself, use `BUSINESS_DATE=2026-11-04 npm start`.

Muse Spark names inputs its own way (`lines[{productId, quantity}]` where the stand-in says `lines[{product, qty}]`), so the demo's client fills its arguments from each tool's input schema, the way an agent reading the schema would.

## Rehearse: the repeat harness

```sh
npm run legacylink -- demo --contoso ../contoso-order-entry --repeat 30 --report demo-report.json
```

Each run starts from a clean state (Contoso reset, state folder wiped, a new `serve`), approves writes through the console API, prints one line, and the harness ends with a pass count and the slowest time per act. A failed run's state folder and full output are kept in `.legacylink-failures/run-<n>/`. Exit code 0 means every run passed.

## If something goes wrong on stage

Go down this list; each step is quicker than debugging.

1. **Explore or learn fails** (a replay miss, a live call that fails): `demo --prebuilt` skips both and uses the checked-in graph and learned tasks from [examples/contoso/](../examples/contoso/). Everything from Compile on is the same.
2. **Live Muse Spark is slow or down**: drop `--model live`; replay is the default. If even replay misses, `--model heuristic`. Heals fall back to the stand-in by themselves.
3. **Port 5180 is busy** (a `serve` left over from a rehearsal): `pkill -f "cli.ts serve"`, or `--console-port 5181`.
4. **Contoso is in a strange state**: `curl -X POST localhost:5080/__admin/reset -H 'content-type: application/json' -d '{}'` or the button on http://localhost:5080/__admin. Every demo run does this first anyway.
5. **The MCP client part fails**: run the tools from the CLI against the state the demo left (`run` heals the same way and asks for approval on the terminal):
   ```sh
   export LEGACYLINK_PASSWORD=demo
   npm run legacylink -- run get_order_status '{"orderNumber":"SO-10042"}'
   curl -X POST localhost:5080/__admin/drift -H 'content-type: application/json' -d '{"rename":true,"move":true}'
   npm run legacylink -- run get_order_status '{"orderNumber":"SO-10042"}'
   ```
6. **Anything else**: play the backup video.

## With your own MCP client

`demo --setup-only` stops after Compile and leaves the three v1 tools in `.legacylink/`. Point Claude Desktop, MCP Inspector or any stdio client at `serve` (config in [compiler.md](compiler.md#mcp-client-config)), approve in the console, and flip drift on http://localhost:5080/__admin to show the heal.

## Gotchas

- Restart `serve` before the demo: more than 5 heals of one tool in an hour marks it broken ([healer.md](healer.md)). The demo starts a fresh `serve` every run, so this only matters for a long-running one.
- The write's verify run during Compile saves an order (SO-10045 after a reset), so Adventure Works shows two orders. That's expected.
- After a demo, the tools in `.legacylink/` are at v2 and drift is off; the next call would heal back to the original controls (v3). The next `demo` wipes them anyway.
