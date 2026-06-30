import { runWorkflow } from "./workflow.js";

export { runWorkflow } from "./workflow.js";
export * as schemas from "./schemas.js";

/**
 * CLI entry point. Reads the customer request from the first CLI argument or
 * from stdin, runs the Threadbot full-placement workflow on Runware, and prints
 * the final node's parsed output as JSON.
 *
 *   RUNWARE_API_KEY=... node dist/index.js "make me a black streetwear tee"
 *   echo "make me a black streetwear tee" | RUNWARE_API_KEY=... node dist/index.js
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main() {
  const argInput = process.argv.slice(2).join(" ").trim();
  const input = argInput || (await readStdin());
  if (!input) {
    console.error('Usage: node dist/index.js "<customer request>"  (or pipe the request on stdin)');
    process.exit(1);
  }

  const result = await runWorkflow({ input_as_text: input });
  process.stdout.write(JSON.stringify(result.output_parsed, null, 2) + "\n");
}

// Run main() only when executed directly (not when imported as a library).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
