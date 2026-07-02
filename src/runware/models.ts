/**
 * Runware model registry for the Threadbot pipeline.
 *
 * Models are addressed by their Runware AIR identifier (creator:family@version).
 * Identifiers below were verified against the Runware docs / model explorer:
 *
 *   LLMs (textInference / chat completions)
 *   - openai:gpt@5.5            GPT-5.5. Frontier reasoning, strict jsonSchema
 *                               structured outputs, thinkingLevel control.
 *   - anthropic:claude@opus-4.8 Claude Opus 4.8. Best-in-class judgment,
 *                               policy nuance, long-horizon tool execution and
 *                               customer-facing writing.
 *   - minimax:m3@0              MiniMax M3. Frontier agentic model, 1M context,
 *                               strong tool calling at low cost.
 *   - minimax:m2.7@0            MiniMax M2.7. "Solid default for production
 *                               assistants that call tools", dependable task
 *                               decomposition, 131K context.
 *   - deepseek:v4@flash         DeepSeek-V4-Flash. Very fast/cheap, 1M context,
 *                               tool use. Ideal for mechanical extraction and
 *                               rule-following nodes.
 *
 *   Image models (imageInference)
 *   - bfl:6@1                   FLUX.2 [flex]. Text-to-image + instruction
 *                               editing, precise text placement, stable
 *                               layouts, up to 10 reference images. The
 *                               workhorse for master art, panel derivation,
 *                               slicing, mirroring and seamless patterns.
 *   - recraft:v4.1-pro@0        Recraft V4.1 Pro. Premium design/brand output,
 *                               the strongest typography/logo/icon rendering.
 *                               Used for label lockups and text-led panels.
 *   - bfl:flux@vto              FLUX Virtual Try-On. person+garment reference
 *                               images -> photoreal on-model garment renders.
 *
 *   Media tools
 *   - runware:112@5             BiRefNet General via taskType "removeBackground"
 *                               for transparent PNG placement files.
 *   - imageUpscale              Print-resolution upscaling.
 *   - promptEnhance             Optional prompt expansion.
 *   - modelSearch               Programmatic model discovery.
 */

export const LLM = {
  GPT_5_5: "openai:gpt@5.5",
  CLAUDE_OPUS_4_8: "anthropic:claude@opus-4.8",
  MINIMAX_M3: "minimax:m3@0",
  MINIMAX_M2_7: "minimax:m2.7@0",
  DEEPSEEK_V4_FLASH: "deepseek:v4@flash"
} as const;

export const IMAGE = {
  FLUX_2_FLEX: "bfl:6@1",
  RECRAFT_V4_1_PRO: "recraft:v4.1-pro@0",
  FLUX_VTO: "bfl:flux@vto",
  BIREFNET_GENERAL: "runware:112@5",
  /**
   * FLUX.1 [dev]: supports advancedFeatures.layerDiffuse for NATIVE
   * transparent-background generation (verified: real alpha channel in the
   * output PNG). Used for transparent placement art; FLUX.2 does not
   * support LayerDiffuse.
   */
  FLUX_1_DEV: "runware:101@1"
} as const;

export interface NodeModelChoice {
  model: string;
  thinkingLevel: "low" | "medium" | "high";
  rationale: string;
}

/**
 * Per-node model selection. The original workflow ran every node on a single
 * generalist model; on Runware each node gets the model best suited to its
 * task. thinkingLevel mirrors the original reasoning effort ("medium") except
 * where the task is mechanical enough that "low" is strictly better.
 */
export const NODE_MODELS: Record<string, NodeModelChoice> = {
  "Threadbot Intake Orchestrator": {
    model: LLM.DEEPSEEK_V4_FLASH,
    thinkingLevel: "low",
    rationale:
      "Pure pass-through extraction into a fixed JSON shape. Fastest/cheapest capable model wins."
  },
  "Customer Intent Agent": {
    model: LLM.GPT_5_5,
    thinkingLevel: "medium",
    rationale:
      "Nuanced natural-language parsing of messy prompts into a large strict schema; GPT-5.5 leads structured extraction."
  },
  "Policy + IP Gate": {
    model: LLM.CLAUDE_OPUS_4_8,
    thinkingLevel: "medium",
    rationale:
      "IP/policy judgment calls with tool-backed screening; Claude Opus is strongest on safety nuance without over-blocking."
  },
  "Product Discovery Agent": {
    model: LLM.MINIMAX_M3,
    thinkingLevel: "medium",
    rationale:
      "Multi-tool catalog retrieval and rerank; MiniMax M3 offers frontier agentic tool calling with 1M context at low cost."
  },
  "Product Selector": {
    model: LLM.GPT_5_5,
    thinkingLevel: "medium",
    rationale:
      "Constraint-heavy selection with five validation tools and hard truth gates; needs top-tier reasoning + tool reliability."
  },
  "Pricing Basis Agent": {
    model: LLM.MINIMAX_M2_7,
    thinkingLevel: "medium",
    rationale:
      "Dependable tool execution and honest status classification; M2.7 is built for production tool-calling assistants."
  },
  "Design Program Compiler": {
    model: LLM.CLAUDE_OPUS_4_8,
    thinkingLevel: "medium",
    rationale:
      "Tool-free creative compilation of a product-wide design system; Opus excels at coherent creative direction."
  },
  "Product-Surface Planner": {
    model: LLM.GPT_5_5,
    thinkingLevel: "high",
    rationale:
      "The hardest planning node: full placement-coverage reasoning across surface graphs, geometry and mockup rules."
  },
  "Product Options Resolver": {
    model: LLM.DEEPSEEK_V4_FLASH,
    thinkingLevel: "low",
    rationale:
      "Single-tool lookup plus deterministic rule application (lowercase stitch_color); fast model, strict rules."
  },
  "Technical QA Agent": {
    model: LLM.GPT_5_5,
    thinkingLevel: "medium",
    rationale:
      "Exhaustive checklist validation against tool-backed truth; benefits from precise, skeptical reasoning."
  },
  "Placement Bundle Compiler": {
    model: LLM.CLAUDE_OPUS_4_8,
    thinkingLevel: "medium",
    rationale:
      "Long-horizon iteration over every placement job with strict completion gates; Opus leads long-horizon tool execution."
  },
  "Mockup Render Agent": {
    model: LLM.GPT_5_5,
    thinkingLevel: "medium",
    rationale:
      "Intricate pre-flight validation, provider error taxonomy and one-shot repair logic; needs exact rule-following."
  },
  "Final Response Composer": {
    model: LLM.CLAUDE_OPUS_4_8,
    thinkingLevel: "medium",
    rationale:
      "Customer-facing prose with strict no-jargon rules; Opus writes the cleanest customer language."
  }
};
