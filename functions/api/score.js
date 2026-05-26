/* =====================================================================
   EVERYBODY KNOWS YOU — AI Discoverability backend  v2
   (Cloudflare Pages Function — drop at /functions/api/score.js)
   ---------------------------------------------------------------------
   Two-stage flow, one endpoint:
     1) DISCOVER  — user typed a NAME. We ask Serper, identify candidate
                    owned site (skipping LinkedIn/Wikipedia/etc.), list
                    the profiles AI sees, and compute Layer A (Presence
                    & identity). Returns stage="needs_confirmation".
     2) AUDIT     — user confirmed a URL (or pasted one). We fetch the
                    site, compute Layer B (Your own hub) including the
                    sameAs CROSS-VERIFICATION against the profiles AI
                    found, and return the final 0-100 score.
     2b) NO_SITE  — user said "I don't have a website yet". We return
                    Layer A only, score capped at 45.

   ENV (Cloudflare Pages > Settings > Variables and secrets):
     SERPER_API_KEY   (Secret) — required for NAME search.
                       URL-paste audits work without it.
     ALLOWED_ORIGIN   (Variable) — e.g. "https://everybodyknowsyou.com".
                       Defaults to "*".
   ===================================================================== */

/* ---------- profile platforms (these are NOT candidate "owned" sites) ---------- */
const PLATFORMS = {
  linkedin:   ["linkedin.com"],
  wikipedia:  ["wikipedia.org"],
  wikidata:   ["wikidata.org"],
  twitter:    ["twitter.com", "x.com"],
  instagram:  ["instagram.com"],
  facebook:   ["facebook.com", "fb.com"],
  youtube:    ["youtube.com", "youtu.be"],
  tiktok:     ["tiktok.com"],
  threads:    ["threads.net"],
  github:     ["github.com"],
  imdb:       ["imdb.com"],
  crunchbase: ["crunchbase.com"],
  spotify:    ["spotify.com"],
  medium:     ["medium.com"],
  substack:   ["substack.com"],
  behance:    ["behance.net"],
  dribbble:   ["dribbble.com"],
  patreon:    ["patreon.com"],
  pinterest:  ["pinterest.com"],
  reddit:     ["reddit.com"],
  quora:      ["quora.com"],
  goodreads:  ["goodreads.com"],
  vimeo:      ["vimeo.com"],
  soundcloud: ["soundcloud.com"],
  aboutme:    ["about.me"],
  linktree:   ["linktr.ee", "beacons.ai", "bio.link"]
};

/* News/PR sites that should never be picked as someone's "own" site */
const NEWS_PR = [
  "bloomberg.com","forbes.com","businesswire.com","prnewswire.com",
  "reuters.com","techcrunch.com","nytimes.com","theverge.com","wsj.com",
  "ft.com","yahoo.com","businessinsider.com","cnbc.com","bbc.com",
  "cnn.com","wired.com","gizmodo.com","mashable.com","fastcompany.com"
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
    const result = await handle(body, context.env || {});
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again.", _debug: { msg: String((err && err.message) || err), stack: String((err && err.stack) || "").split("\n").slice(0,8).join(" | "), name: String(err && err.name || "") } }), { status: 200, headers });
  }
}

function cors(context) {
  const allow = (context.env && context.env.ALLOWED_ORIGIN) || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

/* =====================================================================
   ROUTER  —  decides DISCOVER vs AUDIT vs NO_SITE based on the payload.
   ===================================================================== */
async function handle(body, env) {
  const query = (body && body.query ? String(body.query) : "").trim();
  const country = body && body.country ? String(body.country) : "";
  const countryName = body && body.countryName ? String(body.countryName) : "";
  const explicitMode = body && body.mode ? String(body.mode) : "";
  const confirmedUrl = body && body.confirmedUrl ? String(body.confirmedUrl) : "";
  const passedProfiles = Array.isArray(body && body.profiles) ? body.profiles : [];
  const passedMatches = (body && typeof body.matches === "number") ? body.matches : null;

  if (!query && !confirmedUrl) return { error: "Please type your name, business, or website." };

  // Auto-decide mode if not given
  let mode = explicitMode;
  if (!mode) {
    if (confirmedUrl) mode = "audit";
    else if (looksLikeUrl(query)) mode = "audit";
    else mode = "discover";
  }

  if (mode === "no_site") {
    return await modeNoSite({ query, country, countryName, passedProfiles, passedMatches }, env);
  }
  if (mode === "audit") {
    const url = confirmedUrl || query;
    return await modeAudit({ url, name: query, country, countryName, passedProfiles, passedMatches }, env);
  }
  return await modeDiscover({ query, country, countryName }, env);
}

/* =====================================================================
   MODE: DISCOVER  —  ask Serper, find candidate + profiles, score Layer A
   ===================================================================== */
async function modeDiscover({ query, country, countryName }, env) {
  if (!env.SERPER_API_KEY) {
    return {
      stage: "needs_confirmation",
      candidate: null,
      profiles: [],
      matches: 1,
      layerA: emptyLayerA("Name search is not enabled (no Serper key configured)."),
      layerATotal: 0
    };
  }

  const search = await serper(query, country, env);
  if (!search.ok) {
    return {
      stage: "needs_confirmation",
      candidate: null,
      profiles: [],
      matches: 1,
      layerA: emptyLayerA("Search is temporarily unavailable. Paste your URL instead."),
      layerATotal: 0
    };
  }

  const profiles = extractProfiles(search.data, query);
  const candidate = pickCandidate(search.data);
  const matches = estimateMatches(search.data, query);
  const hasKnowledgeGraph = !!(search.data.knowledgeGraph && (search.data.knowledgeGraph.title || search.data.knowledgeGraph.description));

  const layerA = computeLayerA({ hasKnowledgeGraph, profiles, matches });

  return {
    stage: "needs_confirmation",
    candidate,                 // {url,title,snippet,source} | null
    profiles,                  // [{platform,url,title}]
    matches,
    layerA: layerA.bySignal,
    layerATotal: layerA.total
  };
}

/* =====================================================================
   MODE: NO_SITE  —  user said they have no site. Layer A only, cap 45.
   ===================================================================== */
async function modeNoSite({ query, country, countryName, passedProfiles, passedMatches }, env) {
  // Reuse passed profiles if we have them; else search again.
  let profiles = passedProfiles;
  let matches = (typeof passedMatches === "number") ? passedMatches : 1;
  let hasKnowledgeGraph = passedProfiles.length > 0 ? null : false;

  if (!profiles.length && env.SERPER_API_KEY) {
    const search = await serper(query, country, env);
    if (search.ok) {
      profiles = extractProfiles(search.data, query);
      matches = estimateMatches(search.data, query);
      hasKnowledgeGraph = !!(search.data.knowledgeGraph && (search.data.knowledgeGraph.title || search.data.knowledgeGraph.description));
    }
  }
  if (hasKnowledgeGraph === null) hasKnowledgeGraph = false; // assume none unless we just searched

  const layerA = computeLayerA({ hasKnowledgeGraph, profiles, matches });

  const signals = layerAToSignals(layerA.bySignal).concat(layerBPlaceholderSignals());
  return {
    stage: "result",
    score: layerA.total,
    scoreCap: 45,
    hasNoSite: true,
    resolvedUrl: null,
    candidate: null,
    profiles,
    matches,
    layerA: layerA.bySignal, layerATotal: layerA.total,
    layerB: null, layerBTotal: null,
    signals
  };
}

/* =====================================================================
   MODE: AUDIT  —  full Layer A + Layer B audit on a URL.
   ===================================================================== */
async function modeAudit({ url, name, country, countryName, passedProfiles, passedMatches }, env) {
  const target = normalizeUrl(url);
  if (!target) return { error: "That URL doesn't look right. Try again." };

  const origin = originOf(target);
  const isUrlPasted = !passedProfiles.length;  // true means user pasted URL directly

  // ---- Fetch the site (parallel) ----
  const [home, llms, llmsFull, robots, sitemap] = await Promise.all([
    fetchText(target),
    fetchText(origin + "/llms.txt"),
    fetchText(origin + "/llms-full.txt"),
    fetchText(origin + "/robots.txt"),
    fetchText(origin + "/sitemap.xml")
  ]);

  if (!home.ok && !llms.ok) {
    return { error: "We couldn't reach that website. Check the address and try again." };
  }

  const html = home.text || "";
  const sd = analyzeJsonLd(extractJsonLd(html));

  // ---- Layer A ----
  // If we already discovered profiles, reuse them. Otherwise we have what
  // the site itself declares via sameAs as a proxy for AI's view.
  let profiles = passedProfiles;
  let matches = (typeof passedMatches === "number") ? passedMatches : 1;
  let hasKnowledgeGraph = false;

  if (!isUrlPasted) {
    // came from confirm step; trust the passed data
    hasKnowledgeGraph = !!(passedProfiles && passedProfiles.length > 0 && passedProfiles.some(p => p.fromKG));
  } else if (env.SERPER_API_KEY && (sd.name || name)) {
    // URL-paste path: enrich Layer A with a quick Serper using the entity name
    const searchName = sd.name || (name && !looksLikeUrl(name) ? name : "");
    if (searchName) {
      const search = await serper(searchName, country, env);
      if (search.ok) {
        profiles = extractProfiles(search.data, searchName);
        matches = estimateMatches(search.data, searchName);
        hasKnowledgeGraph = !!(search.data.knowledgeGraph && (search.data.knowledgeGraph.title || search.data.knowledgeGraph.description));
      }
    }
  }
  // If still no profiles, fall back to the site's own sameAs declarations as a proxy
  if (!profiles.length && sd.sameAs.length) {
    profiles = sd.sameAs.map(u => ({ platform: classifyHost(u) || "other", url: u, title: "" }))
      .filter(p => p.platform !== "other" || true);
    matches = 1;
  }

  const layerA = computeLayerA({ hasKnowledgeGraph, profiles, matches, isUrlPasted });

  // ---- Layer B ----
  const layerB = computeLayerB({
    home, llms, llmsFull, robots, sitemap,
    html, sd, target, profiles
  });

  const signals = layerAToSignals(layerA.bySignal).concat(layerBToSignals(layerB.bySignal));
  const total = layerA.total + layerB.total;

  return {
    stage: "result",
    score: total,
    scoreCap: 100,
    hasNoSite: false,
    resolvedUrl: target,
    candidate: null,
    profiles,
    matches,
    layerA: layerA.bySignal, layerATotal: layerA.total,
    layerB: layerB.bySignal, layerBTotal: layerB.total,
    signals
  };
}

/* =====================================================================
   LAYER A — Presence & identity (max 45)
     A1 knowledgeGraph        15 pts  (full = present, none = absent)
     A2 profileBreadth        20 pts  (1=>7, 2=>13, 3+=>20)
     A3 identityClarity       10 pts  (matches: 1=>10, 2-3=>5, 4+=>0)
   ===================================================================== */
function computeLayerA({ hasKnowledgeGraph, profiles, matches, isUrlPasted = false }) {
  const platformsSeen = new Set((profiles || []).map(p => p.platform).filter(Boolean));
  const breadth = platformsSeen.size;

  const a1state = hasKnowledgeGraph ? "full" : "none";
  const a1pts = a1state === "full" ? 15 : 0;

  let a2pts = 0, a2state = "none";
  if (breadth >= 3) { a2pts = 20; a2state = "full"; }
  else if (breadth === 2) { a2pts = 13; a2state = "partial"; }
  else if (breadth === 1) { a2pts = 7; a2state = "partial"; }

  let a3pts = 0, a3state = "none";
  if (isUrlPasted || matches <= 1) { a3pts = 10; a3state = "full"; }
  else if (matches <= 3) { a3pts = 5; a3state = "partial"; }

  const bySignal = {
    knowledgeGraph: { state: a1state, points: a1pts, max: 15, meta: {} },
    profileBreadth: { state: a2state, points: a2pts, max: 20, meta: { count: breadth, platforms: [...platformsSeen] } },
    identityClarity: { state: a3state, points: a3pts, max: 10, meta: { matches } }
  };
  return { bySignal, total: a1pts + a2pts + a3pts };
}

function emptyLayerA(note) {
  return {
    knowledgeGraph: { state: "none", points: 0, max: 15, meta: { note } },
    profileBreadth: { state: "none", points: 0, max: 20, meta: { count: 0, platforms: [] } },
    identityClarity: { state: "none", points: 0, max: 10, meta: { matches: 0 } }
  };
}

function layerAToSignals(la) {
  return [
    { id: "kg",       layer: "A", ...la.knowledgeGraph },
    { id: "profiles", layer: "A", ...la.profileBreadth },
    { id: "clarity",  layer: "A", ...la.identityClarity }
  ];
}

/* =====================================================================
   LAYER B — Your own hub (max 55)
     B1 ownedSite                       15  (reachable homepage)
     B2 llmsTxt                         10  (llms.txt or llms-full.txt)
     B3 structuredData                  10  (Schema.org Person/Org)
     B4 sameAsCrossVerification         10  (site sameAs ∩ found profiles)
     B5 pageBasicsCanonicalHttpsCrawl   10  (title/desc/OG + canonical + https + robots/sitemap)
   ===================================================================== */
function computeLayerB({ home, llms, llmsFull, robots, sitemap, html, sd, target, profiles }) {
  let __phase = "start";
  try {
    __phase = "B1";
    const b1state = home.ok ? "full" : (home.status > 0 ? "partial" : "none");
    const b1pts = b1state === "full" ? 15 : (b1state === "partial" ? 8 : 0);
    __phase = "B2";
    const llmsBody = (llms.ok && llms.text.trim()) || (llmsFull.ok && llmsFull.text.trim()) || "";
    const b2state = llmsBody.length > 200 ? "full" : (llmsBody.length > 0 ? "partial" : "none");
    const b2pts = b2state === "full" ? 10 : (b2state === "partial" ? 5 : 0);
    __phase = "B3";
    const richEntity = sd.hasEntity && sd.name && (sd.hasDescription || sd.hasImage);
    const b3state = richEntity ? "full" : (sd.hasEntity ? "partial" : "none");
    const b3pts = b3state === "full" ? 10 : (b3state === "partial" ? 5 : 0);
    __phase = "B4_profileHosts";
    const profileHosts = new Set((profiles || []).map(p => hostOf(p.url)).filter(Boolean));
    __phase = "B4_sameAsHosts";
    const sameAsHosts = new Set((sd.sameAs || []).map(hostOf).filter(Boolean));
    __phase = "B4_loop";
    let crossMatches = 0;
    for (const h of sameAsHosts) if (profileHosts.has(h)) crossMatches++;
    let b4state = "none", b4pts = 0;
    if (crossMatches >= 2) { b4state = "full"; b4pts = 10; }
    else if (crossMatches === 1) { b4state = "partial"; b4pts = 5; }
    else if (sameAsHosts.size >= 1 && profileHosts.size === 0) { b4state = "partial"; b4pts = 5; }
    __phase = "B5_lower";
    const lower = html.toLowerCase();
    __phase = "B5_title";
    const hasTitle = /<title[^>]*>\s*\S+/i.test(html);
    __phase = "B5_desc";
    const hasDesc  = /<meta[^>]+name=["\u0027]description["\u0027][^>]+content=["\u0027][^"\u0027]{20,}/i.test(html);
    __phase = "B5_og";
    const hasOg    = /<meta[^>]+property=["\u0027]og:(title|description|image)["\u0027]/i.test(html);
    __phase = "B5_canon";
    const hasCanon = /<link[^>]+rel=["\u0027]canonical["\u0027][^>]+href=/i.test(html);
    __phase = "B5_https";
    const isHttps  = (target.startsWith("https://")) || ((home.finalUrl || "").startsWith("https://"));
    __phase = "B5_noindex";
    const noindex  = /<meta[^>]+name=["\u0027]robots["\u0027][^>]+content=["\u0027][^"\u0027]*noindex/i.test(html);
    __phase = "B5_robots";
    const robotsLines = ((robots && robots.text) || "").toLowerCase().split("\n").map(s => s.replace(/[\t ]/g, ""));
    const robotsOk = robots.ok && !robotsLines.includes("disallow:/");
    __phase = "B5_sitemap";
    const sitemapOk = sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.text);
    __phase = "B5_score";
    let b5pts = 0;
    if (hasTitle) b5pts += 2;
    if (hasDesc)  b5pts += 2;
    if (hasOg)    b5pts += 2;
    if (hasCanon) b5pts += 2;
    if (isHttps && !noindex) b5pts += 1;
    if (robotsOk || sitemapOk) b5pts += 1;
    let b5state = "none";
    if (b5pts >= 8) b5state = "full";
    else if (b5pts >= 4) b5state = "partial";
    __phase = "build_bySignal";
    const bySignal = {
      ownedSite:         { state: b1state, points: b1pts, max: 15, meta: { status: home.status } },
      llmsTxt:           { state: b2state, points: b2pts, max: 10, meta: { length: llmsBody.length, file: llms.ok ? "llms.txt" : (llmsFull.ok ? "llms-full.txt" : null) } },
      structuredData:    { state: b3state, points: b3pts, max: 10, meta: { types: sd.types, name: sd.name || "" } },
      sameAsCrossVerify: { state: b4state, points: b4pts, max: 10, meta: { matches: crossMatches, siteSameAs: [...sameAsHosts], profileHosts: [...profileHosts] } },
      pageBasics:        { state: b5state, points: b5pts, max: 10, meta: { hasTitle: hasTitle, hasDesc: hasDesc, hasOg: hasOg, hasCanon: hasCanon, isHttps: isHttps && !noindex, crawlable: robotsOk || sitemapOk } }
    };
    return { bySignal, total: b1pts + b2pts + b3pts + b4pts + b5pts };
  } catch (e) {
    throw new Error("computeLayerB_FAIL@" + __phase + ": " + (e && e.message));
  }
}

function layerBToSignals(lb) {
  return [
    { id: "site",         layer: "B", ...lb.ownedSite },
    { id: "llms",         layer: "B", ...lb.llmsTxt },
    { id: "schema",       layer: "B", ...lb.structuredData },
    { id: "sameas_xref",  layer: "B", ...lb.sameAsCrossVerify },
    { id: "basics",       layer: "B", ...lb.pageBasics }
  ];
}
function layerBPlaceholderSignals() {
  return [
    { id: "site",        layer: "B", state: "none", points: 0, max: 15, meta: { noSite: true } },
    { id: "llms",        layer: "B", state: "none", points: 0, max: 10, meta: { noSite: true } },
    { id: "schema",      layer: "B", state: "none", points: 0, max: 10, meta: { noSite: true } },
    { id: "sameas_xref", layer: "B", state: "none", points: 0, max: 10, meta: { noSite: true } },
    { id: "basics",      layer: "B", state: "none", points: 0, max: 10, meta: { noSite: true } }
  ];
}

/* =====================================================================
   SERPER + result parsing
   ===================================================================== */
async function serper(query, country, env) {
  try {
    const res = await withTimeout(fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        q: query,
        gl: (country && country !== "__" ? country.toLowerCase() : "us"),
        num: 10
      })
    }));
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false };
  }
}

function extractProfiles(data, name) {
  const organic = Array.isArray(data.organic) ? data.organic : [];
  const seen = new Set();
  const profiles = [];
  for (const r of organic) {
    const plat = classifyHost(r.link);
    if (!plat) continue;
    const key = plat + "|" + hostOf(r.link);
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push({ platform: plat, url: r.link, title: r.title || "" });
  }
  // Also consider knowledgeGraph attributes
  if (data.knowledgeGraph) {
    if (Array.isArray(data.knowledgeGraph.attributes)) {
      // sometimes social links live here as URLs in values
    }
    if (Array.isArray(data.knowledgeGraph.profiles)) {
      for (const p of data.knowledgeGraph.profiles) {
        const plat = classifyHost(p.link);
        if (plat && !seen.has(plat + "|" + hostOf(p.link))) {
          profiles.push({ platform: plat, url: p.link, title: p.name || "", fromKG: true });
          seen.add(plat + "|" + hostOf(p.link));
        }
      }
    }
  }
  return profiles;
}

function pickCandidate(data) {
  // 1) Serper knowledgeGraph.website is the strongest signal
  if (data.knowledgeGraph && data.knowledgeGraph.website) {
    const u = normalizeUrl(data.knowledgeGraph.website);
    if (u && !isThirdParty(u)) {
      return {
        url: u,
        title: data.knowledgeGraph.title || hostOf(u),
        snippet: data.knowledgeGraph.description || "",
        source: "knowledgeGraph"
      };
    }
  }
  // 2) First organic that is NOT a platform / NOT news/PR
  const organic = Array.isArray(data.organic) ? data.organic : [];
  for (const r of organic) {
    if (!r.link) continue;
    if (!isThirdParty(r.link)) {
      return {
        url: normalizeUrl(r.link),
        title: r.title || hostOf(r.link),
        snippet: r.snippet || "",
        source: "organic"
      };
    }
  }
  return null;
}

function estimateMatches(data, name) {
  const organic = Array.isArray(data.organic) ? data.organic : [];
  if (!organic.length) return 1;
  const nm = (name || "").toLowerCase();
  const titleHits = organic.filter(o => ((o.title || "") + " " + (o.snippet || "")).toLowerCase().includes(nm)).length;
  const distinctHosts = new Set(organic.map(o => hostOf(o.link)).filter(Boolean));
  // Heuristic: more distinct hosts mentioning the name -> more candidates with that name
  return Math.max(1, Math.min(distinctHosts.size, Math.round(titleHits / 1.5)) || 1);
}

/* ---------- platform classification + filters ---------- */
function classifyHost(url) {
  const h = hostOf(url);
  if (!h) return null;
  for (const [plat, suffixes] of Object.entries(PLATFORMS)) {
    if (suffixes.some(s => h === s || h.endsWith("." + s) || h.endsWith(s))) return plat;
  }
  return null;
}
function isThirdParty(url) {
  const h = hostOf(url);
  if (!h) return false;
  if (classifyHost(url)) return true;
  if (NEWS_PR.some(d => h === d || h.endsWith("." + d))) return true;
  return false;
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch (e) { return ""; }
}

/* ---------- JSON-LD parsing ---------- */
function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { blocks.push(JSON.parse(m[1].trim())); } catch (e) {}
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
  const ENTITY = ["Person","Organization","LocalBusiness","Corporation","Brand","Book","Product","WebSite"];
  const types = [];
  let name = "", sameAs = [], hasEntity = false, hasDescription = false, hasImage = false;
  flat.forEach(node => {
    const t = node["@type"];
    const tlist = Array.isArray(t) ? t : (t ? [t] : []);
    tlist.forEach(x => { if (typeof x === "string") types.push(x); });
    if (tlist.some(x => ENTITY.includes(x))) hasEntity = true;
    if (node.name && !name) name = String(node.name);
    if (node.description) hasDescription = true;
    if (node.image) hasImage = true;
    if (node.sameAs) sameAs = sameAs.concat(Array.isArray(node.sameAs) ? node.sameAs : [node.sameAs]);
  });
  return {
    hasEntity, hasDescription, hasImage,
    types: [...new Set(types)],
    name,
    sameAs: [...new Set(sameAs)]
  };
}

/* ---------- url + fetch helpers ---------- */
function looksLikeUrl(q) {
  if (!q) return false;
  return /^https?:\/\//i.test(q) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(q);
}
function normalizeUrl(q) {
  if (!q) return "";
  q = String(q).trim();
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
