# Threadbot Full-Placement Backend — Runware.ai Edition

Backend for a clothing design app: a multi-agent "product design compiler" that
turns a messy customer request into a policy-screened, product-validated,
full-placement apparel design with real print-ready artwork files and a
provider-backed mockup. Formerly built on the OpenAI Agents SDK; now rewritten
to run on the **Runware.ai** platform.

## Hard invariant (unchanged)

After product selection, the complete design artifact is `placement_bundle_json`.
No downstream node may treat one `placement_file_url` as the whole product
design. A run only becomes mockup-ready when supported placements are
discovered from product truth, required placements are identified, every
required placement has a job, every required generated placement has a real
public file URL, submitted files match the mockup payload rules, and required
product options are resolved.

## What was preserved verbatim (per owner constraint)

- **All agent instructions** — `src/instructions.ts`
- **All agent output JSON schemas (Zod)** — `src/schemas.ts`
- Node order, state handoffs, truth gates, and per-node handoff prompts —
  `src/workflow.ts`
- MCP server labels, allowlists, and URLs for policy, product intelligence,
  pricing, and Printful mockups — `src/agents.ts`

Do not modify instructions or schemas without explicit approval.

## What now runs on Runware

### 1. Every LLM node (`textInference` / chat completions)

The single generalist model was replaced with per-task selections
(`src/runware/models.ts`, AIR identifiers verified against the Runware model
catalog):

| Pipeline node | Runware model | Why |
| --- | --- | --- |
| Intake Orchestrator | `deepseek:v4@flash` | Mechanical extraction into a fixed JSON shape; fastest capable model |
| Customer Intent Agent | `openai:gpt@5.5` | Nuanced NL parsing into a large strict schema |
| Policy + IP Gate | `anthropic:claude@opus-4.8` | Best judgment on IP/policy nuance without over-blocking; reliable tool use |
| Product Discovery Agent | `minimax:m3@0` | Frontier agentic tool calling, 1M context, low cost |
| Product Selector | `openai:gpt@5.5` | Constraint-heavy validation across five truth tools |
| Pricing Basis Agent | `minimax:m2.7@0` | Dependable production tool calling and honest status classification |
| Design Program Compiler | `anthropic:claude@opus-4.8` | Strongest coherent creative direction (tool-free node) |
| Product-Surface Planner | `openai:gpt@5.5` (thinking: high) | Hardest planning node: full coverage over surface graphs/geometry/rules |
| Product Options Resolver | `deepseek:v4@flash` | One tool + deterministic rules (lowercase stitch_color) |
| Technical QA Agent | `openai:gpt@5.5` | Exhaustive skeptical checklist validation |
| Placement Bundle Compiler | `anthropic:claude@opus-4.8` | Long-horizon multi-tool execution with strict completion gates |
| Mockup Render Agent | `openai:gpt@5.5` | Intricate pre-flight validation, error taxonomy, repair logic |
| Final Response Composer | `anthropic:claude@opus-4.8` | Cleanest customer-facing prose under strict no-jargon rules |

Runtime (`src/runware/agent.ts`): tool loops run against Runware's
OpenAI-compatible `/v1/chat/completions` (standard `tools` / `tool_calls` /
`role:"tool"` round trip); the final structured output is produced by native
`textInference` with a **strict `jsonSchema`** derived from the node's Zod
schema, then Zod-validated with one repair retry. MCP tools execute
client-side via `@modelcontextprotocol/sdk` (streamable HTTP) — a drop-in
replacement for the former `hostedMcpTool`.

### 2. Artwork generation (`generate_panel_artwork_bundle`)

The Placement Bundle Compiler's instructions require the exact tool
`generate_panel_artwork_bundle`. That tool is now implemented locally
(`src/tools/artworkBundleTool.ts`) on Runware image models — same name, same
role, so the instructions apply unchanged:

| Artwork task | Runware model | Why |
| --- | --- | --- |
| Master / hero / side / detail / wrap panels | **FLUX.2 [flex]** `bfl:6@1` | Stable layouts, precise text placement, instruction editing, up to 10 reference images |
| derive/slice/mirror/continuation from master | **FLUX.2 [flex]** `bfl:6@1` + master as reference image | Multi-reference consistency across placements/seams |
| Label lockups / typography-led panels | **Recraft V4.1 Pro** `recraft:v4.1-pro@0` | Best-in-class text/logo/icon rendering |
| Seamless repeat patterns | **FLUX.2 [flex]** `bfl:6@1` (tileable prompt contract) | Reliable edge-aligned repeats |
| Transparent PNG output contract | **BiRefNet General** `runware:112@5` via `removeBackground` | Clean masks, PNG transparency |
| Print-resolution scaling | `imageUpscale` | Meets placement DPI/geometry contracts |

Every generated file is a real hosted public URL (`im.runware.ai`; default
retention 7 days, extendable via `ttl`), satisfying the public-URL invariant.
Set `THREADBOT_ARTWORK_MCP_URL` to fall back to the original hosted artwork
MCP server instead of the Runware implementation.

### 3. Media toolkit

`src/runware/media.ts` wraps the native task API: `imageInference`,
`removeBackground`, `imageUpscale`, `promptEnhance`, `modelSearch`, and
**FLUX Virtual Try-On** (`bfl:flux@vto` — person + garment reference images →
photoreal on-model render, preserving prints/logos/stitching).

## What stayed on existing services (and why)

- **Policy / product-intelligence / pricing MCP servers** — these are
  catalog/business-truth services (surface graphs, template geometry, mockup
  payload rules, variant pricing). Runware is a media/LLM platform and has no
  equivalent; the instructions and schemas also hard-reference these tools.
- **Printful mockups MCP** — the Mockup Render Agent's instructions and the
  `MockupRenderAgentSchema` hard-code Printful (`provider: "printful"`,
  `source_truth_status: "printful_mockup_task_backed"`, Printful tool names).

### Proposed follow-up that needs your approval first

Runware's **FLUX Virtual Try-On** could replace or augment Printful mockups
with on-model lifestyle renders (`RunwareMedia.virtualTryOn` is already
implemented and unit-usable). Wiring it into the Mockup Render Agent would
require changing that agent's instructions and the mockup schema's provider
enums — both frozen without your approval, so it is **not** wired in.

## Layout

```
src/
  index.ts                  CLI entry: npm run dev -- "<customer request>"
  workflow.ts               State machine (order/gates/prompts preserved)
  agents.ts                 Agent definitions + MCP toolsets + model routing
  instructions.ts           VERBATIM agent instructions (frozen)
  schemas.ts                VERBATIM Zod output schemas (frozen)
  runware/
    client.ts               Native task API + OpenAI-compatible chat client
    agent.ts                Agent/Runner/mcpToolset/withTrace runtime
    models.ts               AIR identifiers + per-node selection rationale
    media.ts                imageInference/removeBackground/upscale/VTO/etc.
  tools/
    artworkBundleTool.ts    generate_panel_artwork_bundle on Runware models
```

## Running

```bash
npm install
export RUNWARE_API_KEY=...   # https://my.runware.ai
npm run dev -- "black tee with a gothic botanical snake wrapping front and back, no words"
```

Optional env: `RUNWARE_BASE_URL` (default `https://api.runware.ai/v1`),
`THREADBOT_ARTWORK_MCP_URL` (fall back to hosted artwork MCP).
