/**
 * CLI entry point.
 *
 *   RUNWARE_API_KEY=... npm run dev -- "black t-shirt with a gothic botanical
 *   snake design wrapping front and back, no words"
 */

import { runWorkflow } from "./workflow.js";

const main = async () => {
  const input = process.argv.slice(2).join(" ").trim();
  if (!input) {
    console.error('Usage: npm run dev -- "<customer request>"');
    process.exit(1);
  }
  const result = await runWorkflow({ input_as_text: input });
  console.log(JSON.stringify(result.output_parsed, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
