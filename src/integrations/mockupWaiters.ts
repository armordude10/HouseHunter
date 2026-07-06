/**
 * Mockup task waiters: lets Printful's v2 `mockup_task_finished` webhook
 * resolve an in-flight createAndWaitForMockups call instantly, instead of
 * discovering completion on the next poll tick. Polling stays as a fallback
 * race — a dropped webhook delivery can never strand a run.
 */

export interface WebhookTaskData {
  id: number;
  status: string;
  catalog_variant_mockups?: Array<{ mockups: Array<Record<string, unknown>> }>;
  failure_reasons?: unknown[];
}

const waiters = new Map<number, (task: WebhookTaskData) => void>();

export const webhookStats = { received: 0, matched: 0, unmatched: 0 };

/** Resolves when the webhook reports the task, or null after timeoutMs. */
export const waitForTaskWebhook = (
  taskId: number,
  timeoutMs: number
): Promise<WebhookTaskData | null> =>
  new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      waiters.delete(taskId);
      resolve(null);
    }, timeoutMs);
    waiters.set(taskId, (task) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(taskId);
      resolve(task);
    });
  });

/** Called by the webhook endpoint. Returns true if a waiter was listening. */
export const resolveTaskWebhook = (task: WebhookTaskData): boolean => {
  webhookStats.received += 1;
  const waiter = waiters.get(task.id);
  if (!waiter) {
    webhookStats.unmatched += 1;
    return false;
  }
  webhookStats.matched += 1;
  waiter(task);
  return true;
};
