# Explorer

The explorer crawls a legacy web app with Playwright and writes `graph.json` in the screen graph format from [architecture.md](architecture.md#format-1-the-screen-graph). It is the first stage of the pipeline; the learner reads its output.

## Run it

```sh
npm install
npx playwright install chromium     # once, if this machine has no Playwright browser yet

# Contoso Order Entry running locally (npm start in that repo)
LEGACYLINK_PASSWORD=demo npm run legacylink -- explore --url http://localhost:5080 --user demo
```

It writes to `.legacylink/`:

```
.legacylink/
  graph.json
  artifacts/explore/<screen-id>.png   # one screenshot per screen
  model-cache/<inputHash>.json        # recorded model answers (live and replay modes)
  runs/<date>.jsonl                   # model_call events
```

Against Contoso it takes about 10 seconds and finds 6 screens and 36 edges, 30 of them explored. [examples/contoso/graph.json](../examples/contoso/graph.json) is a checked-in run (heuristic mode, no drift) for the learner to build against. It also works against the static build under a base path (`--url http://localhost:5090/contoso-order-entry/`).

## Model modes

| `LEGACYLINK_MODEL` | What names screens and controls | Use it for |
| --- | --- | --- |
| `live` (default when `MODEL_API_KEY` is set) | Muse Spark; every answer is recorded in `model-cache/`, and a recorded answer is reused | real runs, recording the demo |
| `replay` | recorded answers only; a missing one is an error | rehearsals and the live demo |
| `heuristic` (default without a key) | a rule-based stand-in with the same JSON in and out | tests, CI, offline work |

Live mode calls the Meta Model API's OpenAI-compatible Chat Completions endpoint with a JSON-schema `response_format`. Defaults: `MUSE_BASE_URL=https://api.meta.ai/v1`, `MUSE_MODEL=muse-spark-1.3`, `Authorization: Bearer $MODEL_API_KEY`. Confirmed with our key on 2026-10-26: `/v1/models` lists `muse-spark-1.1`, `-1.2` and `-1.3`, and 1.3 answers schema-constrained JSON with a screenshot attached. Don't use the `-contributor` variants: they let Meta train on the prompts.

- Muse Spark 1.3 is a reasoning model. Hidden reasoning tokens count as completion tokens (a heal answer is about 400 to 1,300 tokens, a learned task 3,000 to 4,600), so the client sets no `max_tokens`. With too small a budget the API returns `content: null` and `finish_reason: "length"`.
- Behind a proxy that adds the `Authorization` header itself (the Claude cloud environment does this for `api.meta.ai`), leave `MODEL_API_KEY` unset and pass `--model live` or `LEGACYLINK_MODEL=live`: the client then sends no header. Node's `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` (Node 22.21 or later).

Measured on Contoso: a full live explore is 14 calls and about 110 s; learning one task is one call, 10 to 18 s; one heal is two calls, 3 to 7 s each.

Each answer is checked against a JSON Schema and against the screen (every element named once, keys unique, refs real). A bad answer gets one retry with the errors attached; a second one fails the run. The cache key is the prompt id, model and structured input. The screenshot is sent but not hashed, so a changing clock or date on screen can't break replay.

Prompts: [prompts/explore-screen.md](../prompts/explore-screen.md) (name the screen and its controls, pick next actions) and [prompts/explore-search-values.md](../prompts/explore-search-values.md) (pick search values from data already seen).

## How a crawl goes

1. Open the start page. If it has a password field, record it as the login screen, sign in with the given credentials and record the edge.
2. On each page: capture elements deterministically ([src/explorer/snapshot.ts](../src/explorer/snapshot.ts)), find the screen by URL path plus title or heading, ask the model to name what's new, build ranked locators and keep only those that resolve to exactly that element right now.
3. Queue the actions the model picked. Navigation runs first, then postbacks (grid rows, Cancel), then searches, so searches run after the most sample data has been seen. Search values come only from data seen on earlier screens.
4. Each action starts from a clean load of the state it came from: a URL, plus any postbacks needed to get the page back (a search result grid only exists after the search).
5. Stop when nothing is left or the budget is used up (30 screens, 200 actions).
6. Load every screen in a fresh, logged-out browser to set `requiresLogin`, validate the graph and write it.

## Safety rules

The explorer never presses anything that could change data, whatever the model says:

- A button the model calls `commit`, a button with no role, and any button whose caption starts like a commit (Save, Submit, Post, Delete, Approve, "Cancel Order", OK and so on) is a commit. It gets an `unexplored` commit edge listing the form fields it would submit.
- Links that read like Delete, Remove, Void, Approve or Post are commits too.
- Log out links are recorded but never followed.
- Only a plain Cancel, Close or Back is pressed, as a `cancel`.

The tests check this against a fixture app that records every commit it receives, and a run against Contoso leaves its order count unchanged.

## Conventions the format leaves open

- **Edge ids** are `<from screen>:<via key>`, so each control on a screen has at most one edge.
- **gridLinks** are one element per link column, and their locators resolve inside a grid row, the way the runner's `clickRow` will use them: by role and name when every row has the same caption ("Select"), otherwise by cell position (`td:nth-child(1) a`).
- **Outputs** in label/value tables get a label-relative CSS locator after the id (`td:text-is("Balance") + td span`), so the healer has something that survives an id rename.
- **Controls in a grid row**, like order lines, are labelled from the column header and row: "Qty (row 2)".
- **Screens with only an empty state** keep the elements seen so far. Elements that appear later (a result grid, an order's details) are merged into the same screen, and fingerprint landmarks are the union.

## Known limits

- Messages that only show after a commit (Contoso's "Order SO-10045 saved") aren't in the graph, because the explorer never commits. The compiler's verify run, behind the approval gate, is where those are first seen.
- One search per screen with one set of values; error states (no results, unknown order) are only recorded if the chosen values produce them.
- Heuristic names come from ids and captions (`customerId`, `saveOrder`, `ordersOrderNumberLink`). Muse Spark is expected to give better keys and intents; the format is the same either way.
