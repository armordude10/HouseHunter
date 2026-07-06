/* Threadbot mobile bootstrap: Supabase auth gate + per-account localStorage sync.
   Real auth: email/password sign-in, sign-up WITH email verification (+ resend).
   Social providers (Google/Apple/Microsoft) are added once their OAuth apps are
   registered in Supabase — see PRODUCTION.md. Injects the app runtime (support.js)
   only AFTER auth + hydration so each account loads its own closet/designs/profile. */
(function () {
  var cfg = window.THREADBOT_CONFIG || (window.THREADBOT_CONFIG = {});
  if (!window.supabase) { console.error("Threadbot: supabase-js failed to load"); return; }
  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: "pkce" },
  });
  window.__tbSupabase = sb;

  function loadApp() {
    var s = document.createElement("script");
    s.src = "support.js";
    document.body.appendChild(s);
  }

  /* Device-local keys never mirrored to the account: the Supabase session
     token must stay on-device, and syncing it also churned app_state. */
  function skipSync(k) { return k.indexOf("sb-") === 0; }

  async function hydrate(userId) {
    try {
      var r = await sb.from("app_state").select("key,value").eq("user_id", userId);
      (r.data || []).forEach(function (row) {
        if (skipSync(row.key)) return;
        try {
          localStorage.setItem(row.key, typeof row.value === "string" ? row.value : JSON.stringify(row.value));
        } catch (e) {}
      });
    } catch (e) { console.warn("Threadbot hydrate failed", e); }
  }

  function startSync(userId) {
    var orig = localStorage.setItem.bind(localStorage);
    var dirty = {}, timer = null;
    localStorage.setItem = function (k, v) {
      orig(k, v);
      if (skipSync(k)) return;
      dirty[k] = 1; clearTimeout(timer); timer = setTimeout(flush, 800);
    };
    async function flush() {
      var keys = Object.keys(dirty); dirty = {};
      if (!keys.length) return;
      /* One row per request so a single oversized/failed key can never sink
         the whole batch (this is what silently ate closet saves). Failures
         re-queue and retry on the next flush. */
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var raw = localStorage.getItem(k), val;
        try { val = JSON.parse(raw); } catch (_) { val = raw; }
        try {
          var r = await sb.from("app_state").upsert({ user_id: userId, key: k, value: val });
          if (r.error) throw r.error;
        } catch (e) {
          console.warn("Threadbot sync failed for " + k, e);
          dirty[k] = 1; clearTimeout(timer); timer = setTimeout(flush, 5000);
        }
      }
    }
  }

  async function loadBackendUrl() {
    try {
      var r = await sb.from("app_config").select("value").eq("key", "backend_url").maybeSingle();
      if (r.data && r.data.value) cfg.backendUrl = r.data.value;
    } catch (e) {}
  }

  async function onAuthed(session, overlayEl) {
    cfg.apiKey = session.access_token;
    sb.auth.onAuthStateChange(function (_evt, s) { if (s && s.access_token) cfg.apiKey = s.access_token; });
    await loadBackendUrl();
    await hydrate(session.user.id);
    startSync(session.user.id);
    if (overlayEl) overlayEl.remove();
    loadApp();
  }

  // ---- Social OAuth (Google / Microsoft via Supabase) -------------------
  var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var OAUTH_CB = "threadbot://auth-callback";
  function caps() { return (window.Capacitor && window.Capacitor.Plugins) || {}; }
  var oauthBound = false;
  function ensureOAuthListener() {
    if (oauthBound || !caps().App) return;
    oauthBound = true;
    caps().App.addListener("appUrlOpen", async function (ev) {
      var url = (ev && ev.url) || "";
      if (url.indexOf("auth-callback") === -1) return;
      try { if (caps().Browser) await caps().Browser.close(); } catch (e) {}
      try {
        var code = (url.match(/[?&]code=([^&]+)/) || [])[1];
        if (code) {
          var ex = await sb.auth.exchangeCodeForSession(decodeURIComponent(code));
          if (ex.error) throw ex.error;
          if (ex.data && ex.data.session) return onAuthed(ex.data.session, document.getElementById("tb-auth"));
        }
        var at = (url.match(/[#&]access_token=([^&]+)/) || [])[1];
        var rt = (url.match(/[#&]refresh_token=([^&]+)/) || [])[1];
        if (at && rt) {
          var ss = await sb.auth.setSession({ access_token: decodeURIComponent(at), refresh_token: decodeURIComponent(rt) });
          if (ss.error) throw ss.error;
          if (ss.data && ss.data.session) return onAuthed(ss.data.session, document.getElementById("tb-auth"));
        }
      } catch (e) { console.warn("OAuth callback failed", e); }
    });
  }
  async function social(provider, setStatus) {
    ensureOAuthListener();
    try {
      setStatus("Opening sign-in…", true);
      var res = await sb.auth.signInWithOAuth({ provider: provider, options: { redirectTo: OAUTH_CB, skipBrowserRedirect: isNative } });
      if (res.error) throw res.error;
      if (isNative && res.data && res.data.url) {
        if (caps().Browser) await caps().Browser.open({ url: res.data.url, presentationStyle: "popover" });
        else window.open(res.data.url, "_system");
      }
    } catch (e) {
      var m = (e && e.message) || "Sign-in failed.";
      if (/not enabled|unsupported provider/i.test(m)) m = "This login isn't enabled yet — finish provider setup in Supabase (see PRODUCTION.md).";
      setStatus(m, false);
    }
  }

  // ---- Auth UI ----------------------------------------------------------
  var I = {
    field: "width:100%;padding:14px;margin:7px 0;background:#0d1217;border:1px solid #1d2a30;border-radius:12px;color:#cfe9ee;font-size:15px;box-sizing:border-box;outline:none",
    primary: "width:100%;padding:14px;margin-top:14px;background:#00E5FF;border:0;border-radius:12px;color:#04221f;font-weight:700;font-size:15px;cursor:pointer",
    ghost: "width:100%;padding:12px;margin-top:9px;background:transparent;border:1px solid #1d2a30;border-radius:12px;color:#cfe9ee;font-size:14px;cursor:pointer",
    link: "background:none;border:0;color:#7fd7e6;font-size:13px;cursor:pointer;padding:6px;text-decoration:underline",
    social: "width:100%;display:flex;align-items:center;justify-content:center;gap:10px;padding:13px;margin-top:9px;background:#11181e;border:1px solid #24333b;border-radius:12px;color:#eafcff;font-size:14px;cursor:pointer",
  };

  function showLogin() {
    var wrap = document.createElement("div");
    wrap.id = "tb-auth";
    wrap.setAttribute("style",
      "position:fixed;inset:0;z-index:2147483647;background:radial-gradient(120% 90% at 50% -10%,#0c1622,#07080a 60%);color:#cfe9ee;display:flex;align-items:center;justify-content:center;font-family:'Chakra Petch',system-ui,sans-serif;padding:24px;padding-top:calc(24px + env(safe-area-inset-top));padding-bottom:calc(24px + env(safe-area-inset-bottom))");
    document.body.appendChild(wrap);

    var state = { mode: "signin", busy: false, email: "", pass: "" };

    function setMsg(box, text, ok) {
      box.style.color = ok ? "#9fe6c9" : "#ff7b7b";
      box.textContent = text || "";
    }

    function render() {
      var head =
        '<img src="assets/threadbot-icon.png" alt="Threadbot" style="width:104px;height:104px;object-fit:contain;display:block;margin:0 auto 12px;filter:drop-shadow(0 0 16px rgba(0,229,255,0.45))"/>' +
        '<div style="font-size:27px;letter-spacing:3px;color:#00E5FF;text-align:center">THREADBOT</div>' +
        '<div style="opacity:.55;margin:6px 0 22px;font-size:11px;letter-spacing:1px;text-align:center">WEAR YOUR CREATIVITY</div>';

      var body;
      if (state.mode === "sent") {
        body =
          '<div style="text-align:center;font-size:14px;line-height:1.6;color:#bfeaf1;margin:8px 0 4px">We sent a confirmation link to<br><b style="color:#eafcff">' + esc(state.email) + '</b></div>' +
          '<div style="text-align:center;font-size:12px;color:#7d8c94;margin:10px 0 18px">Tap it, then come back and sign in.</div>' +
          '<button id="a-resend" style="' + I.primary + '">Resend email</button>' +
          '<button id="a-back" style="' + I.ghost + '">Back to sign in</button>' +
          '<div id="a-msg" style="min-height:18px;margin-top:14px;font-size:12px;text-align:center"></div>';
      } else if (state.mode === "forgot") {
        body =
          '<input id="a-email" type="email" placeholder="email" autocapitalize="off" autocomplete="email" value="' + esc(state.email) + '" style="' + I.field + '"/>' +
          '<button id="a-send" style="' + I.primary + '">Send reset link</button>' +
          '<button id="a-back" style="' + I.ghost + '">Back to sign in</button>' +
          '<div id="a-msg" style="min-height:18px;margin-top:14px;font-size:12px;text-align:center"></div>';
      } else {
        var isUp = state.mode === "signup";
        body =
          '<input id="a-email" type="email" placeholder="email" autocapitalize="off" autocomplete="email" value="' + esc(state.email) + '" style="' + I.field + '"/>' +
          '<input id="a-pass" type="password" placeholder="password" autocomplete="' + (isUp ? "new-password" : "current-password") + '" style="' + I.field + '"/>' +
          '<button id="a-go" style="' + I.primary + '">' + (isUp ? "Create account" : "Sign in") + '</button>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">' +
            '<button id="a-toggle" style="' + I.link + '">' + (isUp ? "Have an account? Sign in" : "Create account") + '</button>' +
            (isUp ? '' : '<button id="a-forgot" style="' + I.link + '">Forgot?</button>') +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:10px;margin:16px 0 2px;color:#3f4d54;font-size:11px;letter-spacing:1px"><div style="flex:1;height:1px;background:#1d2a30"></div>OR<div style="flex:1;height:1px;background:#1d2a30"></div></div>' +
          '<button id="a-google" style="' + I.social + '"><svg width="17" height="17" viewBox="0 0 24 24"><path fill="#EA4335" d="M12 10.2v3.9h5.5c-.25 1.42-1.74 4.17-5.5 4.17-3.31 0-6.01-2.74-6.01-6.12S8.69 6.03 12 6.03c1.88 0 3.14.8 3.86 1.49l2.63-2.53C16.79 3.4 14.6 2.4 12 2.4 6.9 2.4 2.79 6.51 2.79 11.62S6.9 20.84 12 20.84c5.3 0 8.81-3.72 8.81-8.96 0-.6-.07-1.06-.15-1.52H12z"/></svg> Continue with Google</button>' +
          '<button id="a-ms" style="' + I.social + '"><svg width="15" height="15" viewBox="0 0 23 23"><path fill="#F25022" d="M1 1h10v10H1z"/><path fill="#7FBA00" d="M12 1h10v10H12z"/><path fill="#00A4EF" d="M1 12h10v10H1z"/><path fill="#FFB900" d="M12 12h10v10H12z"/></svg> Continue with Microsoft</button>' +
          '<div id="a-msg" style="min-height:18px;margin-top:12px;font-size:12px;text-align:center"></div>';
      }

      wrap.innerHTML = '<div style="width:340px;max-width:92vw">' + head + body + '</div>';
      bind();
    }

    function readFields() {
      var e = wrap.querySelector("#a-email"), p = wrap.querySelector("#a-pass");
      if (e) state.email = e.value.trim();
      if (p) state.pass = p.value;
    }
    function busy(b) {
      state.busy = b;
      var btns = wrap.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) btns[i].disabled = b;
    }

    function bind() {
      var msg = wrap.querySelector("#a-msg");
      var go = wrap.querySelector("#a-go");
      if (go) go.onclick = async function () {
        readFields();
        if (!state.email || !state.pass) return setMsg(msg, "Enter email and password.");
        if (state.mode === "signup" && state.pass.length < 6) return setMsg(msg, "Password must be at least 6 characters.");
        busy(true); setMsg(msg, state.mode === "signup" ? "Creating account…" : "Signing in…", true);
        try {
          if (state.mode === "signup") {
            var up = await sb.auth.signUp({ email: state.email, password: state.pass });
            if (up.error) throw up.error;
            if (!up.data.session) { state.mode = "sent"; render(); return; }
            return onAuthed(up.data.session, wrap);
          } else {
            var inn = await sb.auth.signInWithPassword({ email: state.email, password: state.pass });
            if (inn.error) throw inn.error;
            return onAuthed(inn.data.session, wrap);
          }
        } catch (e) {
          var m = (e && e.message) || "Authentication failed.";
          if (/confirm/i.test(m)) m = "Confirm your email first — check your inbox.";
          setMsg(msg, m); busy(false);
        }
      };
      var toggle = wrap.querySelector("#a-toggle");
      if (toggle) toggle.onclick = function () { readFields(); state.mode = state.mode === "signup" ? "signin" : "signup"; render(); };
      var forgot = wrap.querySelector("#a-forgot");
      if (forgot) forgot.onclick = function () { readFields(); state.mode = "forgot"; render(); };
      var back = wrap.querySelector("#a-back");
      if (back) back.onclick = function () { state.mode = "signin"; render(); };
      var resend = wrap.querySelector("#a-resend");
      if (resend) resend.onclick = async function () {
        busy(true); setMsg(msg, "Resending…", true);
        try { var r = await sb.auth.resend({ type: "signup", email: state.email }); if (r.error) throw r.error; setMsg(msg, "Sent. Check your inbox.", true); }
        catch (e) { setMsg(msg, (e && e.message) || "Could not resend."); }
        busy(false);
      };
      var send = wrap.querySelector("#a-send");
      if (send) send.onclick = async function () {
        readFields();
        if (!state.email) return setMsg(msg, "Enter your email.");
        busy(true); setMsg(msg, "Sending…", true);
        try { var r = await sb.auth.resetPasswordForEmail(state.email); if (r.error) throw r.error; setMsg(msg, "Reset link sent — check your inbox.", true); }
        catch (e) { setMsg(msg, (e && e.message) || "Could not send reset."); }
        busy(false);
      };
      var gg = wrap.querySelector("#a-google");
      if (gg) gg.onclick = function () { social("google", function (t, ok) { setMsg(msg, t, ok); }); };
      var msb = wrap.querySelector("#a-ms");
      if (msb) msb.onclick = function () { social("azure", function (t, ok) { setMsg(msg, t, ok); }); };
    }

    render();
  }

  function esc(s) { return String(s || "").replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  (async function init() {
    try {
      var r = await sb.auth.getSession();
      if (r.data && r.data.session) { await onAuthed(r.data.session, null); return; }
    } catch (e) {}
    if (document.body) showLogin();
    else document.addEventListener("DOMContentLoaded", showLogin);
  })();
})();
