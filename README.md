# Threadbot — Runware Backend

Backend for the Threadbot **full-placement product design compiler** (a clothing
app pipeline), rewritten to run entirely on the [Runware.ai](https://runware.ai)
platform.

This replaces the previous OpenAI-Agents implementation. The 13-node pipeline,
every node's **custom instructions**, and every **JSON/Zod output schema** are
preserved verbatim — only the model "brain" of each node and the artwork
generator were migrated to Runware.

## What changed in the migration

| Concern | Before (OpenAI Agents) | After (Runware) |
| --- | --- | --- |
| Orchestration | `@openai/agents` `Agent` + `Runner` + `withTrace` | Hand-rolled runner (`runware-engine.ts` + `workflow.ts`) |
| LLM inference | OpenAI Responses API, `gpt-5.5` everywhere | Runware REST — OpenAI-compatible `POST /v1/chat/completions`, best-fit model per node |
| Structured output | `outputType` (Zod) | Schema supplied as a system contract + Zod re-validation + repair retry |
| Threadbot MCP tools | `hostedMcpTool(...)` (hosted by OpenAI) | Client-side MCP (`@modelcontextprotocol/sdk`, Streamable HTTP) |
| Artwork generation | `threadbot_artwork_mcp.generate_panel_artwork_bundle` | Runware `imageInference` (same tool name, new backend) |
| Printful mockups | `threadbot_printful_mockups_mcp` | unchanged (real POD provider) |

Instructions and schemas are **unchanged**. A couple of instruction strings
mention tool/server names that differ from the real MCP label (e.g. Pricing
Basis says `threadbot_pricing_mockups_mcp`); those strings are kept exactly as
written and the real server wiring lives in `agents.ts` `mcpRefs`.

## Pipeline (unchanged node order)

Intake → Customer Intent → Policy + IP Gate → Product Discovery → Product
Selector → Pricing Basis → Design Program → Surface Planner → Product Options →
Technical QA → Placement Bundle → Mockup Render → Final Response.

The hard invariant is preserved: after product selection the complete design
artifact is `placement_bundle_json`; no node may treat a single
`placement_file_url` as the whole product design. Truth-gate short-circuits
(`can_continue` / `*_pass`) behave exactly as in the original.

## Model selection (best-fit mix, Runware AIR ids)

| Node | Model | Why |
| --- | --- | --- |
| Intake Orchestrator | `google-gemini-3-1-flash-lite` | trivial JSON passthrough — cheapest/fastest |
| Customer Intent | `openai-gpt-5-4-mini` | fast structured NLU parsing |
| Policy + IP Gate | `anthropic-claude-opus-4-8` | safety / IP screening judgment + tools |
| Product Discovery | `openai-gpt-5-4` | retrieval + multi-tool calls |
| Product Selector | `anthropic-claude-opus-4-8` | careful validation + truth gates + tools |
| Pricing Basis | `openai-gpt-5-4` | classification + tools |
| Design Program Compiler | `anthropic-claude-opus-4-8` | creative + instruction-faithful structured reasoning |
| Surface Planner | `openai-gpt-5-5` | heaviest planning + tool orchestration |
| Product Options Resolver | `openai-gpt-5-4-mini` | small single-tool decision |
| Technical QA | `anthropic-claude-opus-4-8` | strict validation reasoning + tools |
| Placement Bundle Compiler | `openai-gpt-5-5` | orchestrates artwork generation across placements |
| Mockup Render | `openai-gpt-5-5` | tool orchestration + provider error handling |
| Final Response Composer | `anthropic-claude-opus-4-8` | customer-facing writing |

All reasoning-capable nodes run at `reasoningEffort: "medium"` (matching the
original); the Final Response Composer also requests a reasoning summary.

### Artwork image models (`generate_panel_artwork_bundle`)

Selected per panel inside `artwork.ts`:

- `recraft:v4.1-pro@0` — default for apparel graphics/logos with crisp edges and
  transparent backgrounds.
- `ideogram:4@0` — panels that must render legible text/typography.
- `bfl:5@1` (FLUX.2 Pro) — photoreal / complex hero illustration.

## Setup

```bash
npm install
cp .env.example .env   # add your RUNWARE_API_KEY
npm run build
```

## Usage

As a CLI:

```bash
RUNWARE_API_KEY=... node dist/index.js "make me a black streetwear tee with a neon koi fish"
# or pipe the request on stdin
echo "all-over galaxy hoodie" | RUNWARE_API_KEY=... node dist/index.js
```

As a library:

```ts
import { runWorkflow } from "threadbot-runware-backend";

const result = await runWorkflow({ input_as_text: "vintage band-style tee, no real band names" });
console.log(result.output_parsed); // FinalResponseComposer output (or the failing node's output)
```

## Environment variables

| Var | Required | Purpose |
| --- | --- | --- |
| `RUNWARE_API_KEY` | yes | Auth for all `textInference` + `imageInference` calls |
| `RUNWARE_BASE_URL` | no | Custom Runware endpoint (`url` constructor arg) |
| `THREADBOT_MCP_BEARER` | no | Bearer token forwarded to the Threadbot MCP servers if they require auth |

## Architecture

```
src/
  index.ts            CLI / library entry point
  workflow.ts         13-node pipeline runner + state passing (verbatim node prompts)
  agents.ts           agent definitions: instructions (verbatim) + model + tool refs
  schemas.ts          Zod output schemas (verbatim)
  runware-engine.ts   runAgent(): chat/completions call, tool-call loop, schema validation + repair
  runware-client.ts   Runware REST config (api key + base URL)
  tools.ts            client-side MCP bridge (Threadbot servers)
  artwork.ts          Runware-backed generate_panel_artwork_bundle tool
```

### Integration notes (verified against the live Runware API)

- **Transport is HTTPS REST, not the SDK's WebSocket.** LLM calls go to the
  OpenAI-compatible `POST {base}/chat/completions`; artwork goes to the native
  tasks endpoint `POST {base}` (array of `imageInference` tasks). REST is used
  because it is verifiable in every environment (some egress proxies block
  outbound WebSockets) and behaves identically on Cloud Run. Base defaults to
  `https://api.runware.ai/v1`.
- **Model IDs use the REST (hyphenated) form** — e.g. `openai-gpt-5-5`,
  `anthropic-claude-opus-4-8`, `google-gemini-3-1-flash-lite`. Image models use
  the native AIR form (`recraft:v4.1-pro@0`, `ideogram:4@0`, `bfl:5@1`). GPT-5.x
  requires `max_completion_tokens` (handled centrally).
- **Structured output is provider-uniform.** Rather than `response_format`
  (which OpenAI, Anthropic, and Google each handle differently on Runware), the
  target JSON Schema is given to the model as a system contract and the answer
  is re-validated against the node's Zod schema. On a validation miss the engine
  runs up to 3 repair passes, feeding the exact failing paths back to the model.
- **Artwork calls self-heal.** Image models differ in which optional params they
  accept (Recraft rejects `negativePrompt`; dimensions are model-specific), so
  the artwork tool drops whatever parameter the API rejects and switches to an
  allowed dimension, then retries.
- All Threadbot MCP servers are connected client-side (with cold-start retry)
  and torn down at the end of each run.

### Runtime dependency: the Threadbot MCP servers must be live

8 of the 13 nodes (Policy, Product Discovery, Product Selector, Pricing, Surface
Planner, Product Options, Technical QA, Mockup Render) call the Threadbot MCP
Cloud Run services. A full end-to-end run requires those four services
(`threadbot-{policy,product-intelligence,pricing-agentbuilder,printful-mockups}-mcp`)
to be reachable. If they are scaled to zero / paused / on a broken revision they
return 5xx and the dependent nodes cannot complete — that is an infrastructure
state, not a code issue. Intake, Customer Intent, Design Program, Placement
Bundle (artwork), and Final Response run without them.
