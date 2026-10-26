# Learner

The learner turns a one-sentence task and the screen graph into a learned task: which screens to visit, which controls take the caller's inputs, which elements hold the outputs, the commit step for a write, and draft input and output schemas. The format is in [architecture.md](architecture.md#the-learned-task). The compiler reads its output. The learner never touches the app.

## Run it

```sh
# after `legacylink explore`, which writes .legacylink/graph.json
npm run legacylink -- learn "Look up a customer's details, credit and orders by customer number"
npm run legacylink -- learn "Get the status of a sales order by its order number"
npm run legacylink -- learn "Create a sales order for a customer with up to three product lines"
```

Each writes `.legacylink/tasks/<tool name>.json`. Options: `--graph <file>` to learn from another graph (e.g. `examples/contoso/graph.json`), `--out <dir>`, `--name <tool_name>` to fix the tool name, and `--model live|replay|heuristic`, the same model modes as the explorer ([explorer.md](explorer.md#model-modes)).

## How it works

1. Load and validate the graph, then make the learner's view of it: no locators, screenshots or fingerprints, and only edges a task can follow (explored ones and commits). This keeps the prompt small and the model away from ids.
2. Ask the model ([prompts/learn-task.md](../prompts/learn-task.md)) for the task as JSON.
3. Check the answer against the graph (the guard listed in the format section). A failed check goes back to the model once with the errors; a second failure fails the stage. Answers are recorded by input hash, so `--model replay` gives the same task every time.
4. Add provenance (sentence, graph date, model) and write the file.

Without `MODEL_API_KEY` the heuristic stand-in answers ([src/model/learn-heuristic.ts](../src/model/learn-heuristic.ts)). It knows two task shapes, which cover the demo: a read (search on a screen, open a grid row if the record shows on another screen, read every output there) and a write (fill the fields the commit control submits, grid rows become an array input, press commit). It picks screens and fields by word overlap with the sentence.

## The demo tasks

[examples/contoso/tasks/](../examples/contoso/tasks/) holds the three tasks learned from the checked-in graph (heuristic mode). A test keeps them in step with the code.

| Tool | Access | Path | Inputs | Outputs |
| --- | --- | --- | --- | --- |
| `get_customer_details` | read | Customer Inquiry: fill Customer #, Search, open the row whose "Customer #" matches → Customer Details | `customerId` | name, contact, phone, city/state, credit limit, balance, available credit, orders table |
| `get_order_status` | read | Order Status: fill Order #, Look Up | `orderNumber` | customer, status, dates, ship via, PO, total, lines table |
| `create_sales_order` | write | New Sales Order: customer, ship to, PO, ship via, up to 3 lines, Save Order (commit) | `customerId`, `shipTo`, `poNumber`, `shipVia`, `lines[{product, qty}]` | `orderNumber` (after commit) |

On Oct 26 a throwaway script walked all three against a local Contoso, using the graph's locators and `src/runner/locate.ts`: C1003's details, SO-10042's status, and a new order SO-10045 that `get_order_status` then read back as Open.

## Notes for the compiler and runner

Seen in that walk:

- Clicks that post back (Search, Look Up, the grid's Select link, Save Order) reload the page; wait for the navigation, not just the click.
- Contoso shows empty values as `-` (Ship Date, PO Number), and Order Status's Customer reads `C1003 - Adventure Works`. A `readBack` post-condition on `create_sales_order` should match the customer by pattern (`^C1003\b`), not by equality.
- Money reads as `$7,500.00`; `parse: "money"` must strip `$` and `,`.
- Optional inputs a caller leaves out (`poNumber`) mean "skip this fill".
- The new order number is in `lblOrderNumber` inside the success message, which the graph has never seen.
