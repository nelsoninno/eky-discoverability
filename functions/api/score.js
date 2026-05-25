/* =====================================================================
   EVERYBODY KNOWS YOU — AI Discoverability backend (Cloudflare Pages Function)
   ---------------------------------------------------------------------
   Lives at:  /functions/api/score.js   ->  serves POST https://YOUR-SITE/api/score

   It performs the REAL audit:
     • fetches /llms.txt, /llms-full.txt, robots.txt, sitemap.xml + the homepage
     • parses Schema.org JSON-LD, sameAs links, Open Graph/meta/title, canonical
     • checks HTTPS / noindex
     • (optional) resolves a NAME -> website using Serper.dev search
     • returns a weighted 0-100 score + per-signal breakdown + improvement tips

   ENVIRONMENT VARIABLES (Cloudflare Pages > Settings > Variables and secrets):
     SERPER_API_KEY   (optional)  free tier at serper.dev — enables NAME search.
                                   Without it, users must paste a URL.
     ALLOWED_ORIGIN   (optional)  e.g. "https://everybodyknowsyou.com".
                                   Defaults to "*" (any site can call it).
   ===================================================================== */

const RUBRIC = [
  { id: "llms_txt",         label: "AI guide file (llms.txt)",                   max: 22 },
  { id: "structured_data",  label: "Structured data (Schema.org / JSON-LD)",     max: 20 },
  { id: "identity_clarity", label: "Clear, single identity",                     max: 14 },
  { id: "meta_seo",         label: "Page basics (title, description, Open Graph)",max: 12 },
  { id: "identity_graph",   label: "Linked profiles (sameAs)",                   max: 10 },
  { id: "crawlability",     label: "Crawlable (robots.txt + sitemap)",           max: 10 },
  { id: "secure_indexable", label: "Secure & indexable (HTTPS, no noindex)",      max: 7 },
  { id: "canonical_entity", label: "Canonical URL & matching name",               max: 5 }
];

const FETCH_TIMEOUT = 8000;

/* ---------- entrypoints ---------- */
export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: cors(context) });
}

export async function onRequestPost(context) {
  const headers = { "Content-Type": "application/json", ...cors(context) };
  try {
    const body = await context.request.json();
    const result = await audit(body, context.env || {});
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: humanError(err) }), { status: 200, headers });
  }
}

/* ---------- CORS ---------- */
function cors(context) {
  const allow = (context.env && context.env.ALLOWED_ORIGIN) || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

/* ---------- main audit ---------- */
async function audit(body, env) {
  const query = (body && body.query ? String(body.query) : "").trim();
  const country = body && body.country ? String(body.country) : "";
  if (!query) return { error: "Please provide a name, business, or website." };

  const isUrl = looksLikeUrl(query);
  let targetUrl, matches = 1, identityNote = "";

  if (isUrl) {
    targetUrl = normalizeUrl(query);
  } else {
    // resolve a NAME -> website via Serper (if configured)
    const resolved = await resolveNameToUrl(query, country, env);
    if (!resolved.url) {
      return {
        error: resolved.reason ||
          "To check a name, the site owner needs to enable name search. For now, paste your exact website URL for an instant audit."
      };
    }
    targetUrl = resolved.url;
    matches = resolved.matches || 1;
    identityNote = resolved.note || "";
  }

  const origin = originOf(targetUrl);

  // fetch everything in parallel
  const [home, llms, llmsFull, robots, sitemap] = await Promise.all([
    fetchText(targetUrl),
    fetchText(origin + "/llms.txt"),
    fetchText(origin + "/llms-full.txt"),
    fetchText(origin + "/robots.txt"),
    fetchText(origin + "/sitemap.xml")
  ]);

  if (!home.ok && !llms.ok) {
    return { error: "We couldn't reach that website. Check the address and try again." };
  }

  const html = home.text || "";
  const lower = html.toLowerCase();

  // ---- signal analysis ----
  const signals = {};

  // 1) llms.txt
  const llmsFound = (llms.ok && llms.text.trim().length > 40);
  const llmsFullFound = (llmsFull.ok && llmsFull.text.trim().length > 40);
  signals.llms_txt = grade(
    llmsFound && llmsFullFound ? "full" : (llmsFound || llmsFullFound ? "full" : (llms.ok || llmsFull.ok ? "partial" : "none")),
    llmsFound ? "Found /llms.txt describing you for AI assistants."
      : (llmsFullFound ? "Found /llms-full.txt." : "No /llms.txt found — AI has no purpose-built summary of you.")
  );

  // 2) structured data (JSON-LD)
  const jsonld = extractJsonLd(html);
  const sd = analyzeJsonLd(jsonld);
  signals.structured_data = grade(
    sd.hasEntity ? (sd.rich ? "full" : "partial") : "none",
    sd.hasEntity ? ("Schema.org " + (sd.types.join(", ") || "entity") + " detected.")
      : "No JSON-LD structured data found."
  );

  // 3) identity clarity
  if (isUrl) {
    signals.identity_clarity = grade("full", "A single canonical website was audited directly.");
  } else if (matches <= 1) {
    signals.identity_clarity = grade("full", "One clear, dominant match for this name.");
  } else if (matches <= 3) {
    signals.identity_clarity = grade("partial", "A few possible matches — some ambiguity for AI.");
  } else {
    signals.identity_clarity = grade("none", "Many people/entities share this name; AI may confuse you.");
  }

  // 4) page basics / light SEO
  const hasTitle = /<title[^>]*>\s*\S+/i.test(html);
  const hasDesc = /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(html);
  const hasOg = /<meta[^>]+property=["']og:(title|description|image)["']/i.test(html);
  const seoScore = (hasTitle ? 1 : 0) + (hasDesc ? 1 : 0) + (hasOg ? 1 : 0);
  signals.meta_seo = grade(
    seoScore >= 3 ? "full" : (seoScore >= 1 ? "partial" : "none"),
    [hasTitle ? "title" : null, hasDesc ? "description" : null, hasOg ? "Open Graph" : null].filter(Boolean).join(", ") || "Missing title/description/Open Graph."
  );

  // 5) sameAs / linked identity graph
  const sameAsCount = sd.sameAs.length;
  signals.identity_graph = grade(
    sameAsCount >= 3 ? "full" : (sameAsCount >= 1 ? "partial" : "none"),
    sameAsCount ? (sameAsCount + " linked profile(s) via sameAs.") : "No linked profiles (sameAs) found."
  );

  // 6) crawlability
  const robotsOk = robots.ok && !/disallow:\s*\/\s*$/im.test(robots.text);
  const sitemapOk = sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.text);
  signals.crawlability = grade(
    robotsOk && sitemapOk ? "full" : (robotsOk || sitemapOk ? "partial" : "none"),
    [robotsOk ? "robots.txt allows crawling" : null, sitemapOk ? "sitemap.xml present" : null].filter(Boolean).join(", ") || "No sitemap / crawling may be blocked."
  );

  // 7) secure & indexable
  const isHttps = targetUrl.startsWith("https://") || (home.finalUrl || "").startsWith("https://");
  const noindex = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html);
  signals.secure_indexable = grade(
    isHttps && !noindex ? "full" : (isHttps || !noindex ? "partial" : "none"),
    (isHttps ? "HTTPS" : "Not HTTPS") + (noindex ? " · noindex set (hidden from AI/search)" : " · indexable")
  );

  // 8) canonical + name match
  const canonical = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html);
  const nameMatches = sd.name && lower.includes(sd.name.toLowerCase());
  signals.canonical_entity = grade(
    canonical && (nameMatches || !sd.name) ? "full" : (canonical || sd.name ? "partial" : "none"),
    canonical ? ("Canonical: " + canonical[1]) : "No canonical URL declared."
  );

  // ---- compute weighted score ----
  const out = RUBRIC.map(r => {
    const g = signals[r.id];
    const points = g.state === "full" ? r.max : (g.state === "partial" ? Math.round(r.max * 0.5) : 0);
    return { id: r.id, label: r.label, max: r.max, points, found: stateToFound(g.state), detail: g.detail };
  });
  const score = out.reduce((a, s) => a + s.points, 0);

  return {
    score,
    resolvedUrl: targetUrl,
    matches,
    note: identityNote,
    signals: out,
    tips: buildTips(out)
  };
}

/* ---------- name -> URL via Serper (optional) ---------- */
async function resolveNameToUrl(name, country, env) {
  const key = env.SERPER_API_KEY;
  if (!key) {
    return { url: null, reason: "Name search isn't enabled on this site yet. Paste your exact website URL to get an instant audit." };
  }
  try {
    const res = await withTimeout(fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: name, gl: (country && country !== "__" ? country.toLowerCase() : "us"), num: 10 })
    }));
    if (!res.ok) return { url: null, reason: "Search is temporarily unavailable. Paste your website URL instead." };
    const data = await res.json();

    // best candidate: knowledge graph website, else first organic result
    let url = null;
    if (data.knowledgeGraph && data.knowledgeGraph.website) url = data.knowledgeGraph.website;
    if (!url && Array.isArray(data.organic) && data.organic.length) url = data.organic[0].link;
    if (!url) return { url: null, reason: "We couldn't find a clear website for that name. Paste your URL for an exact audit." };

    // estimate ambiguity: how many of the top results mention the name in the title
    const nm = name.toLowerCase();
    const organics = Array.isArray(data.organic) ? data.organic : [];
    const distinctDomains = new Set(organics.map(o => { try { return new URL(o.link).hostname.replace(/^www\./, ""); } catch (e) { return o.link; } }));
    const titleHits = organics.filter(o => (o.title || "").toLowerCase().includes(nm)).length;
    const matches = Math.max(1, Math.min(distinctDomains.size, Math.round(titleHits / 1.5)) || 1);

    return { url: normalizeUrl(url), matches, note: "" };
  } catch (e) {
    return { url: null, reason: "Search timed out. Paste your website URL for an exact audit." };
  }
}

/* ---------- JSON-LD ---------- */
function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { blocks.push(JSON.parse(m[1].trim())); } catch (e) { /* ignore malformed */ }
  }
  return blocks;
}
function analyzeJsonLd(blocks) {
  const flat = [];
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n === "object") {
      flat.push(n);
      if (n["@graph"]) walk(n["@graph"]);
    }
  };
  blocks.forEach(walk);

  const types = [];
  let name = "", sameAs = [], hasEntity = false, rich = false;
  const ENTITY = ["Person", "Organization", "LocalBusiness", "Corporation", "Brand", "Book", "Product", "WebSite"];

  flat.forEach(node => {
    const t = node["@type"];
    const tlist = Array.isArray(t) ? t : (t ? [t] : []);
    tlist.forEach(x => { if (typeof x === "string") types.push(x); });
    if (tlist.some(x => ENTITY.includes(x))) hasEntity = true;
    if (node.name && !name) name = String(node.name);
    if (node.sameAs) sameAs = sameAs.concat(Array.isArray(node.sameAs) ? node.sameAs : [node.sameAs]);
    if ((node.description || node.image) && (node.name)) rich = true;
  });

  return { hasEntity, rich, types: [...new Set(types)], name, sameAs: [...new Set(sameAs)] };
}

/* ---------- helpers ---------- */
function grade(state, detail) { return { state, detail }; }
function stateToFound(state) { return state === "full" ? true : (state === "partial" ? "partial" : false); }

function looksLikeUrl(q) {
  return /^https?:\/\//i.test(q) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(q);
}
function normalizeUrl(q) {
  q = q.trim();
  if (!/^https?:\/\//i.test(q)) q = "https://" + q;
  return q.replace(/\s+/g, "");
}
function originOf(url) {
  try { const u = new URL(url); return u.origin; } catch (e) { return url.replace(/\/[^/]*$/, ""); }
}
async function fetchText(url) {
  try {
    const res = await withTimeout(fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "EverybodyKnowsYou-DiscoverabilityBot/1.0 (+https://everybodyknowsyou.com)" }
    }));
    const text = res.ok ? await res.text() : "";
    return { ok: res.ok, status: res.status, text: text.slice(0, 400000), finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: 0, text: "", finalUrl: url };
  }
}
function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), FETCH_TIMEOUT))
  ]);
}
function humanError(err) {
  return "Something went wrong running the check. Please try again in a moment.";
}
function buildTips(signals) {
  const m = {}; signals.forEach(s => m[s.id] = s);
  const tips = [];
  if (m.llms_txt.found !== true) tips.push("Add an /llms.txt file: a short plain-text page telling AI assistants who you are, what you do, and links to your key pages.");
  if (m.structured_data.found !== true) tips.push("Add Schema.org JSON-LD (Person or Organization) with your name, description, image and sameAs links so AI can parse your identity.");
  if (m.identity_graph.found !== true) tips.push("List your official profiles (LinkedIn, Wikipedia, social, press) in a sameAs array to build a verifiable identity graph.");
  if (m.meta_seo.found !== true) tips.push("Set a clear page title, meta description and Open Graph tags so previews and AI summaries are accurate.");
  if (m.crawlability.found !== true) tips.push("Publish a sitemap.xml and make sure robots.txt allows AI and search crawlers.");
  if (m.identity_clarity.found !== true) tips.push("Use the same full name and bio everywhere and link them together so AI doesn't confuse you with someone else who shares your name.");
  if (m.secure_indexable.found !== true) tips.push("Serve your site over HTTPS and remove any 'noindex' that hides you from AI and search engines.");
  if (m.canonical_entity.found !== true) tips.push("Add a canonical URL and make sure your displayed name matches your structured data.");
  return tips;
}
