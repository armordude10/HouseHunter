/* ============================================================================
   Threadbot — Backend Integration Seam
   ----------------------------------------------------------------------------
   The app talks to your synthesis backend through ONE function: generate().
   Replace the MOCK block below with a real call to your image-generation
   service. Everything else in the app (prompt, image upload, saving to the
   Closet, favorites, profile) is real and runs locally with no backend.

   Contract — generate(opts) must return a Promise resolving to:
       { variations: [ { id: string, image: string|null }, ... ] }
   where `image` is a URL or data-URL of the rendered garment (or null to show
   the empty render slot). Call opts.onProgress(pct, statusLabel) during work.

   opts = {
     prompt:     string,        // the user's prompt (already pipeline-enhanced
                                //   server-side; the front end never enhances)
     refImage:   string|null,   // optional reference image as a data-URL
     onProgress: (pct, label) => void,
   }
   ============================================================================ */
(function () {
  const STATUS = [
    'Parsing design intent',
    'Building visual composition',
    'Synthesizing garment structure',
    'Rendering output',
  ];

  window.ThreadbotAPI = {
    statusSteps: STATUS,

    async generate({ prompt, refImage, remix, baseImage, onProgress } = {}) {
      // ---- REAL BACKEND --------------------------------------------------
      // If a backend URL is configured (desktop build injects it via
      // window.THREADBOT_CONFIG.backendUrl; web build can set it on
      // window.THREADBOT_CONFIG too), call it. Otherwise fall back to the
      // local mock below so the app always runs.
      const cfg = (typeof window !== 'undefined' && window.THREADBOT_CONFIG) || {};
      const backendUrl = cfg.backendUrl || '';
      if (backendUrl) {
        // The backend renders for ~60-90s and does NOT stream progress, so simulate a smooth
        // ramp (2% -> 95%, ease-out) and cycle the status labels while the request is in flight,
        // then snap to 100% when it lands. Without this the bar sits frozen at 2% the whole time.
        const ctrl = new AbortController();
        let pct = 2, finished = false;
        if (onProgress) onProgress(pct, STATUS[0]);
        const t0 = Date.now();
        const EXPECTED_MS = 75000;
        const timer = setInterval(function () {
          if (finished) return;
          const k = Math.min(1, (Date.now() - t0) / EXPECTED_MS);
          const target = 2 + Math.round((1 - (1 - k) * (1 - k)) * 93); // ease-out toward 95
          if (target > pct) pct = Math.min(95, target);
          const label = STATUS[Math.min(STATUS.length - 1, Math.floor((pct / 100) * STATUS.length))];
          if (onProgress) onProgress(pct, label);
        }, 250);
        try {
          const res = await fetch(backendUrl, {
            method: 'POST',
            headers: Object.assign(
              { 'Content-Type': 'application/json' },
              cfg.apiKey ? { 'Authorization': 'Bearer ' + cfg.apiKey } : {}
            ),
            // remix=true  -> mutate `baseImage` into adjacent directions (img2img)
            // remix=false -> fresh generations from the prompt (txt2img)
            body: JSON.stringify({ prompt, refImage, remix, baseImage }),
            signal: ctrl.signal,
          });
          if (!res.ok) {
            // Surface the backend's actual reason (refusals, product issues)
            // instead of a bare status code.
            var detail = '';
            try { detail = ((await res.json()) || {}).error || ''; } catch (e2) {}
            throw new Error(detail || ('Synthesis failed: ' + res.status + ' ' + res.statusText));
          }
          const data = await res.json();   // expected: { variations: [{id,image},...] }
          if (!data || !Array.isArray(data.variations)) {
            throw new Error('Backend returned an unexpected shape; expected { variations: [...] }');
          }
          finished = true; clearInterval(timer);
          if (onProgress) onProgress(100, STATUS[STATUS.length - 1]);
          return data;
        } catch (e) {
          finished = true; clearInterval(timer);
          throw e;
        }
      }

      // ---- LOCAL MOCK (runs end-to-end until a backendUrl is configured) --
      const total = 2600;
      const t0 = Date.now();
      await new Promise((resolve) => {
        const tick = () => {
          const k = Math.min(1, (Date.now() - t0) / total);
          const label = STATUS[Math.min(STATUS.length - 1, Math.floor(k * STATUS.length))];
          if (onProgress) onProgress(Math.round(k * 100), label);
          if (k >= 1) resolve();
          else setTimeout(tick, 16);
        };
        tick();
      });

      // The mock produces 4 distinct placeholder renders so variations are
      // visibly different while you test the flow. A real backend returns
      // actual garment images here. REMIX seeds from the current render so its
      // outputs stay near it; VARIATIONS re-rolls fresh from the prompt. If a
      // reference image was supplied, the first variation echoes it so uploads
      // are visibly flowing through.
      const seed = (prompt || 'threadbot') + (remix ? '::remix::' : '::roll::') + t0;
      const variations = [0, 1, 2, 3].map((i) => ({
        id: 'v' + t0 + '-' + i,
        image: i === 0 && refImage && !remix ? refImage : mockRender(seed, i),
      }));
      return { variations };
    },
  };

  // Procedural placeholder render — local dev only.
  function mockRender(seedStr, i) {
    const size = 512;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const x = c.getContext('2d');
    let h = 0;
    for (let n = 0; n < seedStr.length; n++) h = (h * 31 + seedStr.charCodeAt(n)) >>> 0;
    h = (h + i * 2654435761) >>> 0;
    const hue = (200 + (h % 60));            // cyan-ish base
    x.fillStyle = '#0a0f14';
    x.fillRect(0, 0, size, size);
    // diagonal weave
    x.strokeStyle = 'rgba(0,229,255,0.10)';
    x.lineWidth = 1;
    for (let p = -size; p < size; p += 14) {
      x.beginPath(); x.moveTo(p, 0); x.lineTo(p + size, size); x.stroke();
    }
    // garment silhouette block
    const g = x.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, `hsla(${hue},90%,55%,0.22)`);
    g.addColorStop(1, `hsla(${(hue + 40) % 360},90%,55%,0.05)`);
    x.fillStyle = g;
    const m = 96 + (h % 40);
    x.fillRect(m, m, size - m * 2, size - m * 2);
    x.strokeStyle = `hsla(${hue},90%,60%,0.5)`;
    x.lineWidth = 2;
    x.strokeRect(m, m, size - m * 2, size - m * 2);
    // accent mark
    x.fillStyle = `hsla(${hue},95%,62%,0.9)`;
    x.beginPath();
    x.arc(size / 2, size / 2, 22 + (h % 30), 0, Math.PI * 2);
    x.fill();
    x.fillStyle = 'rgba(207,233,238,0.5)';
    x.font = '20px monospace';
    x.fillText('VARIATION 0' + (i + 1), m + 8, size - m - 14);
    return c.toDataURL('image/png');
  }
})();
