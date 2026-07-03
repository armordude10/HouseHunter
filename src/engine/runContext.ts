/**
 * Run-scoped context shared between the workflow runner and in-process tools.
 *
 * Agents pass structured arguments to tools, but some inputs (customer
 * reference images, captions) originate outside the agent transcript and must
 * reach the artwork engine without altering any frozen instruction or schema.
 * The workflow registers them here keyed by run_id; tools look them up by the
 * run_id they receive.
 */

export interface RunContext {
  runId: string;
  customerImageUrls: string[];
  customerImageCaptions: string[];
}

const contexts = new Map<string, RunContext>();

export const registerRunContext = (context: RunContext) => {
  contexts.set(context.runId, context);
};

/**
 * Exact-match lookup. The only permitted fallback is when a SINGLE context
 * exists (single-run CLI process) — with concurrent runs a fuzzy fallback
 * would leak one customer's reference images into another customer's run.
 */
export const getRunContext = (runId?: string | null): RunContext | null => {
  if (runId && contexts.has(runId)) return contexts.get(runId)!;
  if (contexts.size === 1) return [...contexts.values()][0];
  return null;
};

export const clearRunContext = (runId: string) => {
  contexts.delete(runId);
};
