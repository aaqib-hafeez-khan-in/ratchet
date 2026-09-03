import { mountChrome, highlight, tabs } from '/assets/partials.js';
import { beatFor } from '/assets/beat.js';
import { revealSections } from '/assets/reveal.js';
mountChrome('/');

const flow = `# 1. Ask, before you act.
POST /v1/effects/begin
{
  "effect_type": "email.send",
  "idempotency_key": "welcome:user_123",
  "payload": { "to": "sam@example.com" }
}

-> { "decision": "execute", "lease_token": "lt_..." }

# 2. Now do the real thing, yourself.
send_the_email()

# 3. Say what happened.
POST /v1/effects/eff_.../report
{ "lease_token": "lt_...", "outcome": "succeeded",
  "result": { "message_id": "m_9f2" } }

# Any later caller with the same key gets:
-> { "decision": "duplicate", "result": { "message_id": "m_9f2" } }`;
document.getElementById('flow-code').innerHTML = highlight(flow);

const groupExample = `# Declare each step as part of one unit, with its undo.
POST /v1/effects/begin
{
  "effect_type": "flight.book",
  "idempotency_key": "trip:8812:flight",
  "group_key": "trip:8812",
  "compensation": {
    "effect_type": "flight.cancel",
    "payload": { "ref": "FL123" }
  }
}

# Step five fails. Ask for the rollback plan:
POST /v1/groups/trip:8812/unwind

-> { "state": "unwinding",
     "steps": [
       { "order": 1, "undo": "hotel.book"  -> "hotel.cancel" },
       { "order": 2, "undo": "flight.book" -> "flight.cancel" }
     ],
     "irreversible": [ { "effect_type": "email.send" } ] }`;
const gc = document.getElementById('grp-code');
if (gc) gc.innerHTML = highlight(groupExample);

const SNIPPETS = {
  curl: `curl -X POST https://your-host/v1/effects/begin \\
  -H "Authorization: Bearer $RATCHET_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "effect_type": "email.send",
    "idempotency_key": "welcome:user_123",
    "payload": { "to": "sam@example.com" },
    "estimated_cost_micros": 800
  }'`,

  python: `import httpx

def gated(client, effect_type, key, payload, do_it):
    r = client.post("/v1/effects/begin", json={
        "effect_type": effect_type,
        "idempotency_key": key,
        "payload": payload,
    }).json()

    if r["decision"] == "duplicate":
        return r["result"]              # already done; replay it
    if r["decision"] != "execute":
        raise Blocked(r["decision"], r["reason"])

    try:
        result = do_it()                # the real side effect
    except DefinitelyDidNotSend as e:
        client.post(f"/v1/effects/{r['effect_id']}/report", json={
            "lease_token": r["lease_token"],
            "outcome": "failed", "failure_reason": str(e)})
        raise
    # If you are UNSURE it went through, report nothing. The lease lapses
    # and Ratchet records an honest "indeterminate" instead of a wrong "failed".

    client.post(f"/v1/effects/{r['effect_id']}/report", json={
        "lease_token": r["lease_token"],
        "outcome": "succeeded", "result": result})
    return result`,

  ts: `const ratchet = (path: string, body: unknown) =>
  fetch(\`\${BASE}/v1\${path}\`, {
    method: "POST",
    headers: { authorization: \`Bearer \${KEY}\`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const gate = await ratchet("/effects/begin", {
  effect_type: "github.pr.create",
  idempotency_key: \`pr:\${repo}:\${branch}\`,
  payload: { repo, branch, title },
});

if (gate.decision === "duplicate") return gate.result;
if (gate.decision !== "execute") throw new Error(gate.reason);

const pr = await octokit.pulls.create({ ... });

await ratchet(\`/effects/\${gate.effect_id}/report\`, {
  lease_token: gate.lease_token,
  outcome: "succeeded",
  result: { number: pr.data.number, url: pr.data.html_url },
});`,

  mcp: `// Claude Desktop / Claude Code / Cursor — mcp config
{
  "mcpServers": {
    "ratchet": {
      "command": "node",
      "args": ["/path/to/ratchet/dist/mcp/stdio.js"],
      "env": {
        "RATCHET_API_KEY": "rk_live_...",
        "DATABASE_URL": "postgres://..."
      }
    }
  }
}

// Or connect any MCP client over streamable HTTP:
//   POST https://your-host/mcp
//   Authorization: Bearer rk_live_...
//
// Tools: ratchet_begin_effect, ratchet_report_effect,
//        ratchet_check_effect, ratchet_resolve_effect,
//        ratchet_list_effects, ratchet_get_policy, ratchet_usage`,
};

tabs(document.getElementById('int-tabs'), (name) => {
  document.getElementById('int-code').innerHTML = highlight(SNIPPETS[name]);
});


/* ─────────────────────────────────────────── scroll-driven hero explainer
   Beats advance with scroll position rather than on a timer, so the reader
   sets the pace and can stop on any frame.

   Driven by a requestAnimationFrame loop that runs ONLY while the stage is on
   screen, rather than by the scroll event. Scroll events are not dependable
   here: browsers coalesce them during smooth scrolling, they do not fire on
   scroll restoration or a deep link into the middle of the page, and some
   automation contexts never dispatch them at all. An IntersectionObserver
   starts and stops the loop, so nothing runs when the section is out of view.

   Honours prefers-reduced-motion by doing nothing — the CSS already lays the
   beats out as a static stacked diagram in that case. */
(() => {
  const stage = document.querySelector('.stage');
  if (!stage) return;

  const beats = [...stage.querySelectorAll('.beat')];
  const rail = stage.querySelector('.rail');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  const staticLayout = () => { for (const b of beats) b.dataset.active = 'true'; };
  if (reduced.matches) return staticLayout();

  // Dots double as controls, so the sequence is reachable without scrolling.
  rail.innerHTML = beats.map((_, i) =>
    `<button role="tab" aria-label="Step ${i + 1}" data-go="${i}"></button>`).join('');
  const dots = [...rail.querySelectorAll('button')];

  let current = -1;
  const show = (i) => {
    if (i === current) return;
    current = i;
    beats.forEach((b, n) => { b.dataset.active = String(n === i); });
    dots.forEach((d, n) => d.setAttribute('aria-current', String(n === i)));
  };

  const update = () => show(beatFor(
    stage.getBoundingClientRect().top, stage.offsetHeight, innerHeight, beats.length));

  let running = false;
  const tick = () => {
    if (!running) return;
    update();
    requestAnimationFrame(tick);
  };

  // Only animate while the section is actually on screen.
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !running) { running = true; tick(); }
    else if (!entry.isIntersecting) { running = false; }
  }, { rootMargin: '100px' }).observe(stage);

  // Belt and braces: rAF is throttled or paused on low-power devices and in
  // background tabs, where a scroll listener still fires. update() is one
  // getBoundingClientRect, so running it on both is cheap.
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update, { passive: true });

  // Someone may switch the preference mid-session.
  reduced.addEventListener?.('change', (e) => { if (e.matches) { running = false; staticLayout(); } });

  for (const d of dots) {
    d.addEventListener('click', () => {
      const i = Number(d.dataset.go);
      const scrollable = stage.offsetHeight - innerHeight;
      scrollTo({
        top: stage.offsetTop + (scrollable * (i + 0.5)) / beats.length,
        behavior: 'smooth',
      });
    });
  }

  update();
})();

// Everything after the pinned narrative was static while the top of the page
// moved, which read as two different sites stitched together. The stage is
// skipped: it already drives its own scroll animation and would fight this one.
revealSections({ skip: ['.stage'] });

/* ── the counterfactual, scrubbed by scroll ───────────────────────────────
   The landing page's short version of /benchmark. Both read the same seeded
   run from the same module, so the number quoted here cannot drift from the
   number the benchmark page proves. */
(async () => {
  const stage = document.getElementById('counterfactual');
  const canvas = document.getElementById('cfLanes');
  if (!stage || !canvas) return;

  const cf = await import('/assets/counterfactual.js');
  const draw = cf.fitted(canvas);
  const dup = document.getElementById('cfDup');
  const money = document.getElementById('cfMoney');
  const gated = document.getElementById('cfGated');
  const hint = document.getElementById('cfHint');

  cf.onScroll(() => {
    const p = cf.scrollProgress(stage);
    draw((ctx, w, h) => cf.drawLanes(ctx, w, h, p, {
      quiet: cf.token('--text-faint', '#868d99'),
      leak: cf.token('--stop', '#b0341f'),
      gate: cf.token('--accent', '#1c5cff'),
    }));
    const t = cf.tally(p);
    dup.textContent = String(t.duplicates);
    money.textContent = cf.money(t.overpaid);
    gated.textContent = '$0';
    hint.textContent = t.done >= cf.JOBS
      ? `${cf.JOBS} of ${cf.JOBS} · complete` : `${t.done} of ${cf.JOBS}`;
  });
})();

/* ── containment, scrubbed by scroll ──────────────────────────────────────
   The same drawing /fraud uses, from the same module, so the landing page and
   the page it links to cannot end up telling different stories. */
(async () => {
  const stage = document.getElementById('containment');
  const canvas = document.getElementById('ctCanvas');
  if (!stage || !canvas) return;

  const cf = await import('/assets/counterfactual.js');
  const draw = cf.fitted(canvas);
  const ok = document.getElementById('ctOk');
  const no = document.getElementById('ctNo');
  const held = document.getElementById('ctHeld');
  const hint = document.getElementById('ctHint');
  const line = document.getElementById('ctLine');

  cf.onScroll(() => {
    const p = cf.scrollProgress(stage);
    let seen = { tried: 0, landed: 0 };
    draw((ctx, w, h) => {
      seen = cf.drawContainment(ctx, w, h, p, {
        gate: cf.token('--accent', '#1c5cff'),
        stop: cf.token('--stop', '#b0341f'),
        rule: cf.token('--border', '#e3e6ea'),
        dim: cf.token('--text-faint', '#868d99'),
      });
    });
    const permitted = Math.min(seen.tried, cf.PAYOUT.allowed);
    const refused = Math.max(0, seen.tried - cf.PAYOUT.allowed);
    ok.textContent = String(permitted);
    no.textContent = String(refused);
    held.textContent = `$${(refused * cf.PAYOUT.each).toLocaleString('en-US')}`;
    hint.textContent = seen.tried >= cf.PAYOUT.attempts
      ? 'ceiling held' : `${seen.tried} of ${cf.PAYOUT.attempts}`;
    line.textContent = refused > 0
      ? 'Refused at the gate. The vendor is never asked, so nothing has to be undone.'
      : ' ';
  });
})();
