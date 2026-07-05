/* Threadbot mobile config. Supabase keys are client-safe (publishable). */
window.THREADBOT_CONFIG = window.THREADBOT_CONFIG || {};
window.THREADBOT_CONFIG.supabaseUrl = "https://dwexqosfijipthndmtvf.supabase.co";
window.THREADBOT_CONFIG.supabaseKey = "sb_publishable_28gkMfzXhepK6raUUo4ohQ_X7e5MiEK";

/* Deployed backend's /generate endpoint. boot.js also overrides this at runtime from the
   Supabase `app_config` table (key=backend_url), so this is the bundled fallback. */
window.THREADBOT_CONFIG.backendUrl = "https://threadbot-agentic-pipeline-2uts5km5aq-uc.a.run.app/generate";
