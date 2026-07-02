/**
 * CLI entry point.
 *
 *   RUNWARE_API_KEY=... npm run dev -- "black AOP crew neck, ocean waves" \
 *     --image https://example.com/reference.jpg
 *
 * Repeat --image for multiple customer reference images (text/image combo
 * input).
 */

import { runWorkflow } from "./workflow.js";

const main = async () => {
  const args = process.argv.slice(2);
  const imageUrls: string[] = [];
  const textParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--image" && args[i + 1]) {
      imageUrls.push(args[++i]);
    } else {
      textParts.push(args[i]);
    }
  }
  const input = textParts.join(" ").trim();
  if (!input && !imageUrls.length) {
    console.error('Usage: npm run dev -- "<customer request>" [--image <url>]...');
    process.exit(1);
  }
  const result = await runWorkflow({
    input_as_text: input || "Design a garment from the attached reference images.",
    input_image_urls: imageUrls
  });
  console.log(JSON.stringify(result.output_parsed, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
