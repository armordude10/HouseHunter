/**
 * Create a confirmed Supabase test account so you can log into the app immediately
 * (no email confirmation needed).
 *   node --import tsx scripts/create-test-user.ts [email] [password]
 */

import { config } from "../src/config.js";
import { createSupabase } from "../src/core/supabaseStore.js";

const email = process.argv[2] ?? "tester@threadbot.app";
const password = process.argv[3] ?? "ThreadbotS26!";

const sb = createSupabase(config.supabase.url, config.supabase.serviceRoleKey);
const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });

if (error) {
  if (/already|registered|exists/i.test(error.message)) console.log("user already exists:", email);
  else throw error;
} else {
  console.log("created:", data.user?.email, data.user?.id);
}
console.log(`\nLOGIN -> ${email} / ${password}`);
