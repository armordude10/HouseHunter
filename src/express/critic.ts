/**
 * The pipeline's EYES: a multimodal art-director pass on the LOCALLY
 * SIMULATED mockup (src/engine/templateSim.ts) BEFORE the run commits to a
 * real Printful mockup and reaches the customer.
 *
 * It sees the simulated garment sheet next to the customer's literal words
 * and answers one question a human designer answers in half a second: "is
 * this what they asked for?" — catching the whole class of shipped defects
 * (backgrounds left on logos, postage-stamp art, cropped text, wrong base
 * color) with judgment instead of one hardcoded rule per bug.
 *
 * Cost/latency discipline: ONE vision call per run (~1-2¢), on a downsized
 * sheet, with a bounded single correction round executed by the caller.
 * Fails OPEN: if the critic errors or no vision key exists, the run ships
 * exactly as it does today.
 */

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const CRITIC_MODEL = () => process.env.THREADBOT_CRITIC_MODEL ?? "gpt-5.5";

export interface CriticVerdict {
  approved: boolean;
  /** Customer-relevant defects, most severe first. */
  problems: string[];
  /** Bounded, executable corrections for the single retry round. */
  corrections: {
    /** The artwork content itself is wrong — regenerate with this appended guidance. */
    regenerate: boolean;
    regen_hint: string;
  };
}

export const criticEnabled = (): boolean =>
  Boolean(process.env.OPENAI_API_KEY) && process.env.THREADBOT_CRITIC !== "0";

/**
 * One vision judgment. `sheetJpeg` is the simulated contact sheet;
 * request/brief are the customer's literal words and the plan summary.
 */
export const critiqueSimulation = async (params: {
  sheetJpeg: Buffer;
  requestText: string;
  planSummary: string;
}): Promise<CriticVerdict | null> => {
  if (!criticEnabled()) return null;
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["approved", "problems", "regenerate", "regen_hint"],
    properties: {
      approved: { type: "boolean" },
      problems: { type: "array", items: { type: "string" }, maxItems: 6 },
      regenerate: { type: "boolean" },
      regen_hint: { type: "string" }
    }
  };
  const body = {
    model: CRITIC_MODEL(),
    max_completion_tokens: 700,
    reasoning_effort: "low",
    response_format: {
      type: "json_schema",
      json_schema: { name: "design_verdict", strict: true, schema }
    },
    messages: [
      {
        role: "system",
        content:
          "You are the final art director of a print-on-demand pipeline. The image is a LOCAL " +
          "SIMULATION of the product about to be manufactured: each tile shows one print panel's " +
          "artwork through the real garment template (dashed lines/labels are the template's own " +
          "guides, NOT part of the design). Judge ONLY against what the customer literally asked " +
          "for. Reject for: missing or misspelled requested text; requested logo/subject absent, " +
          "unrecognizable, or carrying an unwanted background box; wrong base color; art so small, " +
          "so cropped, or so misplaced a customer would complain. Do NOT reject for style taste, " +
          "template guides, or minor imperfections. approved=true means ship it. If the ARTWORK " +
          "CONTENT itself is wrong (not just placement), set regenerate=true with a one-sentence " +
          "regen_hint describing exactly what must change."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Customer request (verbatim): ${params.requestText.slice(0, 900)}\n` +
              `Pipeline plan: ${params.planSummary.slice(0, 500)}\n` +
              `Simulated product below. Verdict:`
          },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${params.sheetJpeg.toString("base64")}` }
          }
        ]
      }
    ]
  };
  try {
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify(body)
    });
    const parsed = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    if (!response.ok || !parsed?.choices?.[0]?.message?.content) return null;
    const raw = JSON.parse(parsed.choices[0].message.content) as {
      approved: boolean;
      problems: string[];
      regenerate: boolean;
      regen_hint: string;
    };
    return {
      approved: Boolean(raw.approved),
      problems: Array.isArray(raw.problems) ? raw.problems.slice(0, 6) : [],
      corrections: { regenerate: Boolean(raw.regenerate), regen_hint: String(raw.regen_hint ?? "").slice(0, 300) }
    };
  } catch {
    return null; // fail OPEN — the critic must never kill a run
  }
};
