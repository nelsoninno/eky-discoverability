/* =====================================================================
   EVERYBODY KNOWS YOU — AI Discoverability backend  v3 (split modes)
   ---------------------------------------------------------------------
   THREE explicit modes:

     1) url_audit      — user pasted a URL. Pure 100-pt website-quality audit.
                          No Serper call. No identity layer. Just the site.
     2) discover       — user typed a name. Asks Serper, builds candidate +
                          profile list, computes Layer A preview.
                          Returns stage:"needs_confirmation".
     3) identity_audit — user confirmed a URL after discover.
                          Layer A (40) + Layer B (60) = 100,
                          with sameAs CROSS-VERIFICATION.
     3b) no_site       — user said "I don't have a website yet".
                          Layer A only, cap 40.

   Knowledge Panel signal removed (per product decision).
   computeLayerB and computeWebsiteAudit are intentionally regex-free
   (Cloudflare bundler bug with quote-mixed regex char classes).
   ===================================================================== */

const PLATFORMS = {
  linkedin:["linkedin.com"], wikipedia:["wikipedia.org"], wikidata:["wikidata.org"],
  twitter:["twitter.com","x.com"], instagram:["instagram.com"],
  facebook:["facebook.com","fb.com"], youtube:["youtube.com","youtu.be"],
  tiktok:["tiktok.com"], threads:["threads.net"], github:["github.com"],
  imdb:["imdb.com"], crunchbase:["crunchbase.com"], spotify:["spotify.com"],
  medium:["medium.com"], substack:["substack.com"], behance:["behance.net"],
  dribbble:["dribbble.com"], patreon:["patreon.com"], pinterest:["pinterest.com"],
  reddit:["reddit.com"], quora:["quora.com"], goodreads:["goodreads.com"],
  vimeo:["vimeo.com"], soundcloud:["soundcloud.com"], aboutme:["about.me"],
  linktree:["linktr.ee","beacons.ai","bio.link"]
};
const NEWS_PR = [
  "bloomberg.com","forbes.com","businesswire.com","prnewswire.com",
  "reuters.com","techcrunch.com","nytimes.com","theverge.com","wsj.com",
  "ft.com","yahoo.com","businessinsider.com","cnbc.com","bbc.com",
  "cnn.com","wired.com","gizmodo.com","mashable.com","fastcompany.com"
];
const FETCH_TIMEOUT = 8000;

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
    try { console.error("score.js error:", err && (err.stack || err.message || err)); } catch (_) {}
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), { status: 200, headers });
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

async function handle(body, env) {
  const query = (body && body.query ? String(body.query) : "").trim();
  const country = body && body.country ? String(body.country) : "";
  const countryName = body && body.countryName ? String(body.countryName) : "";
  const explicitMode = body && body.mode ? String(body.mode) : "";
  const confirmedUrl = body && body.confirmedUrl ? String(body.confirmedUrl) : "";
  const passedProfiles = Array.isArray(body && body.profiles) ? body.profiles : [];
  const passedMatches = (body && typeof body.matches === "number") ? body.matches : null;

  if (!query && !confirmedUrl) return { error: "Please type your name, business, or website." };

  let mode = explicitMode;
  if (!mode) {
    if (confirmedUrl) mode = "identity_audit";
    else if (looksLikeUrl(query)) mode = "url_audit";
    else mode = "discover";
  }
  // Back-compat: older front-end may still send mode:"audit"
  if (mode === "audit") mode = "identity_audit";

  if (mode === "url_audit") return await modeWebsiteAudit({ url: query }, env);
  if (mode === "no_site")  return await modeNoSite({ query, country, countryName, passedProfiles, passedMatches }, env);
  if (mode === "identity_audit") {
    const url = confirmedUrl || query;
    return await modeIdentityAudit({ url, name: query, country, countryName, passedProfiles, passedMatches }, env);
  }
  return await modeDiscover({ query, country, countryName }, env);
}

/* MODE: url_audit — pasted URL → pure 100-pt website audit */
async function modeWebsiteAudit({ url }, env) {
  const target = normalizeUrl(url);
  if (!target) return { error: "That URL doesn't look right. Try again." };
  const origin = originOf(target);
  const [home, llms, llmsFull, robots, sitemap] = await Promise.all([
    fetchText(target), fetchText(origin + "/llms.txt"), fetchText(origin + "/llms-full.txt"),
    fetchText(origin + "/robots.txt"), fetchText(origin + "/sitemap.xml")
  ]);
  if (!home.ok && !llms.ok) return { error: "We couldn't reach that website. Check the address and try again." };
  const html = home.text || "";
  const sd = analyzeJsonLd(extractJsonLd(html));
  const site = computeWebsiteAudit({ home, llms, llmsFull, robots, sitemap, html, sd, target });
  return {
    stage: "result", mode: "url_audit",
    score: site.total, scoreCap: 100,
    resolvedUrl: target,
    signals: site.signals,
    tips: buildWebsiteTips(site.signals)
  };
}
function computeWebsiteAudit({ home, llms, llmsFull, robots, sitemap, html, sd, target }) {
  const s1state = home.ok ? "full" : (home.status > 0 ? "partial" : "none");
  const s1pts = s1state === "full" ? 10 : (s1state === "partial" ? 5 : 0);
  const llmsBody = (llms.ok && llms.text.trim()) || (llmsFull.ok && llmsFull.text.trim()) || "";
  const s2state = llmsBody.length > 200 ? "full" : (llmsBody.length > 0 ? "partial" : "none");
  const s2pts = s2state === "full" ? 25 : (s2state === "partial" ? 12 : 0);
  const richEntity = sd.hasEntity && sd.name && (sd.hasDescription || sd.hasImage);
  const s3state = richEntity ? "full" : (sd.hasEntity ? "partial" : "none");
  const s3pts = s3state === "full" ? 25 : (s3state === "partial" ? 12 : 0);
  const sameAsHosts = new Set((sd.sameAs || []).map(hostOf).filter(Boolean));
  const sameAsCount = sameAsHosts.size;
  let s4state = "none", s4pts = 0;
  if (sameAsCount >= 3) { s4state = "full"; s4pts = 15; }
  else if (sameAsCount >= 1) { s4state = "partial"; s4pts = 8; }
  const low = (html || "").toLowerCase();
  const hasTitle  = low.indexOf("<title>") !== -1 || low.indexOf("<title ") !== -1;
  const hasDesc   = low.indexOf('name="description"') !== -1 || low.indexOf("name='description'") !== -1;
  const hasOg     = low.indexOf("og:title") !== -1 || low.indexOf("og:description") !== -1 || low.indexOf("og:image") !== -1;
  const hasCanon  = low.indexOf('rel="canonical"') !== -1 || low.indexOf("rel='canonical'") !== -1;
  const isHttps   = target.startsWith("https://") || ((home.finalUrl || "").startsWith("https://"));
  const noindex   = low.indexOf("noindex") !== -1;
  const stripWS = (s) => { let r = ""; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c !== 9 && c !== 32) r += s.charAt(i); } return r; };
  const robotsLines = ((robots && robots.text) || "").toLowerCase().split("\n").map(stripWS);
  const robotsOk = robots.ok && !robotsLines.includes("disallow:/");
  const sitemapText = (sitemap && sitemap.text) || "";
  const sitemapOk = sitemap.ok && (sitemapText.indexOf("<urlset") !== -1 || sitemapText.indexOf("<sitemapindex") !== -1);
  let s5pts = 0;
  if (hasTitle) s5pts += 5;
  if (hasDesc)  s5pts += 5;
  if (hasOg)    s5pts += 5;
  if (hasCanon) s5pts += 4;
  if (isHttps && !noindex)   s5pts += 3;
  if (robotsOk || sitemapOk) s5pts += 3;
  let s5state = "none";
  if (s5pts >= 20) s5state = "full";
  else if (s5pts >= 10) s5state = "partial";
  const signals = [
    { id:"site",   layer:"S", state:s1state, points:s1pts, max:10, meta:{ status: home.status } },
    { id:"llms",   layer:"S", state:s2state, points:s2pts, max:25, meta:{ length: llmsBody.length, file: llms.ok ? "llms.txt" : (llmsFull.ok ? "llms-full.txt" : null) } },
    { id:"schema", layer:"S", state:s3state, points:s3pts, max:25, meta:{ types: sd.types, name: sd.name || "" } },
    { id:"sameas", layer:"S", state:s4state, points:s4pts, max:15, meta:{ count: sameAsCount, hosts: [...sameAsHosts] } },
    { id:"basics", layer:"S", state:s5state, points:s5pts, max:25, meta:{ hasTitle, hasDesc, hasOg, hasCanon, isHttps: isHttps && !noindex, crawlable: robotsOk || sitemapOk } }
  ];
  return { signals, total: s1pts + s2pts + s3pts + s4pts + s5pts };
}
function buildWebsiteTips(signals) {
  const by = {}; signals.forEach(s => by[s.id] = s);
  const out = [];
  if (by.llms   && by.llms.state   !== "full") out.push("Add an /llms.txt — a short plain-text page telling AI assistants who you are and what you do.");
  if (by.schema && by.schema.state !== "full") out.push("Add Schema.org JSON-LD (Person or Organization) on your homepage with name, description, image and sameAs.");
  if (by.sameas && by.sameas.state !== "full") out.push("Declare your real profiles (LinkedIn, Wikipedia, social, press) in sameAs on your homepage.");
  if (by.basics && by.basics.state !== "full") out.push("Set title, meta description, Open Graph image, canonical URL, HTTPS, and allow crawlers.");
  if (by.site   && by.site.state   !== "full") out.push("Make sure your homepage responds and is publicly reachable.");
  return out.length ? out : ["Your website is in excellent shape — keep Schema.org and llms.txt up to date."];
}

/* MODE: discover — name → candidate + profiles + Layer A preview */
async function modeDiscover({ query, country, countryName }, env) {
  if (!env.SERPER_API_KEY) {
    return { stage:"needs_confirmation", mode:"discover", candidate:null, profiles:[], matches:1, layerA: emptyLayerA("Name search is not enabled (no Serper key)."), layerATotal: 0 };
  }
  const search = await serper(query, country, env);
  if (!search.ok) {
    return { stage:"needs_confirmation", mode:"discover", candidate:null, profiles:[], matches:1, layerA: emptyLayerA("Search is temporarily unavailable. Paste your URL instead."), layerATotal: 0 };
  }
  const profiles = extractProfiles(search.data, query);
  const candidate = pickCandidate(search.data, query);
  const matches = estimateMatches(search.data, query);
  const layerA = computeLayerA({ profiles, matches });
  return { stage:"needs_confirmation", mode:"discover", candidate, profiles, matches, layerA: layerA.bySignal, layerATotal: layerA.total };
}

/* MODE: no_site — Layer A only, cap 40 */
async function modeNoSite({ query, country, countryName, passedProfiles, passedMatches }, env) {
  let profiles = passedProfiles;
  let matches = (typeof passedMatches === "number") ? passedMatches : 1;
  if (!profiles.length && env.SERPER_API_KEY) {
    const search = await serper(query, country, env);
    if (search.ok) { profiles = extractProfiles(search.data, query); matches = estimateMatches(search.data, query); }
  }
  const layerA = computeLayerA({ profiles, matches });
  const signals = layerAToSignals(layerA.bySignal).concat(layerBPlaceholderSignals());
  return { stage:"result", mode:"no_site", score: layerA.total, scoreCap: 40, hasNoSite: true, resolvedUrl: null, candidate: null, profiles, matches, layerA: layerA.bySignal, layerATotal: layerA.total, layerB: null, layerBTotal: null, signals };
}

/* MODE: identity_audit — Layer A + Layer B */
async function modeIdentityAudit({ url, name, country, countryName, passedProfiles, passedMatches }, env) {
  const target = normalizeUrl(url);
  if (!target) return { error: "That URL doesn't look right. Try again." };
  const origin = originOf(target);
  const [home, llms, llmsFull, robots, sitemap] = await Promise.all([
    fetchText(target), fetchText(origin + "/llms.txt"), fetchText(origin + "/llms-full.txt"),
    fetchText(origin + "/robots.txt"), fetchText(origin + "/sitemap.xml")
  ]);
  if (!home.ok && !llms.ok) return { error: "We couldn't reach that website. Check the address and try again." };
  const html = home.text || "";
  const sd = analyzeJsonLd(extractJsonLd(html));

  let profiles = passedProfiles;
  let matches = (typeof passedMatches === "number") ? passedMatches : 1;
  if (!profiles.length && sd.sameAs.length) {
    profiles = sd.sameAs.map(u => ({ platform: classifyHost(u) || "other", url: u, title: "" }));
    matches = 1;
  }
  const layerA = computeLayerA({ profiles, matches });
  const layerB = computeLayerB({ home, llms, llmsFull, robots, sitemap, html, sd, target, profiles });
  const signals = layerAToSignals(layerA.bySignal).concat(layerBToSignals(layerB.bySignal));
  const total = layerA.total + layerB.total;
  return { stage:"result", mode:"identity_audit", score: total, scoreCap: 100, hasNoSite: false, resolvedUrl: target, candidate: null, profiles, matches, layerA: layerA.bySignal, layerATotal: layerA.total, layerB: layerB.bySignal, layerBTotal: layerB.total, signals };
}

/* LAYER A — max 40 (no KG)
     profileBreadth   25  (0→0, 1→10, 2→18, 3+→25)
     identityClarity  15  (1→15, 2-3→8, 4+→0)                          */
function computeLayerA({ profiles, matches }) {
  const platformsSeen = new Set((profiles || []).map(p => p.platform).filter(Boolean));
  const breadth = platformsSeen.size;
  let a1pts = 0, a1state = "none";
  if (breadth >= 3) { a1pts = 25; a1state = "full"; }
  else if (breadth === 2) { a1pts = 18; a1state = "partial"; }
  else if (breadth === 1) { a1pts = 10; a1state = "partial"; }
  const m = (typeof matches === "number") ? matches : 1;
  let a2pts = 0, a2state = "none";
  if (m <= 1) { a2pts = 15; a2state = "full"; }
  else if (m <= 3) { a2pts = 8; a2state = "partial"; }
  const bySignal = {
    profileBreadth:  { state: a1state, points: a1pts, max: 25, meta: { count: breadth, platforms: [...platformsSeen] } },
    identityClarity: { state: a2state, points: a2pts, max: 15, meta: { matches: m } }
  };
  return { bySignal, total: a1pts + a2pts };
}
function emptyLayerA(note) {
  return {
    profileBreadth:  { state:"none", points:0, max:25, meta:{ count:0, platforms:[], note } },
    identityClarity: { state:"none", points:0, max:15, meta:{ matches:0 } }
  };
}
function layerAToSignals(la) {
  return [
    { id:"profiles", layer:"A", ...la.profileBreadth },
    { id:"clarity",  layer:"A", ...la.identityClarity }
  ];
}

/* LAYER B — max 60 (regex-free)
     site 8 · llms 14 · schema 14 · sameas_xref 14 · basics 10           */
function computeLayerB({ home, llms, llmsFull, robots, sitemap, html, sd, target, profiles }) {
  const b1state = home.ok ? "full" : (home.status > 0 ? "partial" : "none");
  const b1pts = b1state === "full" ? 8 : (b1state === "partial" ? 4 : 0);
  const llmsBody = (llms.ok && llms.text.trim()) || (llmsFull.ok && llmsFull.text.trim()) || "";
  const b2state = llmsBody.length > 200 ? "full" : (llmsBody.length > 0 ? "partial" : "none");
  const b2pts = b2state === "full" ? 14 : (b2state === "partial" ? 7 : 0);
  const richEntity = sd.hasEntity && sd.name && (sd.hasDescription || sd.hasImage);
  const b3state = richEntity ? "full" : (sd.hasEntity ? "partial" : "none");
  const b3pts = b3state === "full" ? 14 : (b3state === "partial" ? 7 : 0);
  const profileHosts = new Set((profiles || []).map(p => hostOf(p.url)).filter(Boolean));
  const sameAsHosts = new Set((sd.sameAs || []).map(hostOf).filter(Boolean));
  let crossMatches = 0;
  for (const h of sameAsHosts) if (profileHosts.has(h)) crossMatches++;
  let b4state = "none", b4pts = 0;
  if (crossMatches >= 2) { b4state = "full"; b4pts = 14; }
  else if (crossMatches === 1) { b4state = "partial"; b4pts = 7; }
  else if (sameAsHosts.size >= 1 && profileHosts.size === 0) { b4state = "partial"; b4pts = 7; }
  const low = (html || "").toLowerCase();
  const hasTitle = low.indexOf("<title>") !== -1 || low.indexOf("<title ") !== -1;
  const hasDesc  = low.indexOf('name="description"') !== -1 || low.indexOf("name='description'") !== -1;
  const hasOg    = low.indexOf("og:title") !== -1 || low.indexOf("og:description") !== -1 || low.indexOf("og:image") !== -1;
  const hasCanon = low.indexOf('rel="canonical"') !== -1 || low.indexOf("rel='canonical'") !== -1;
  const isHttps  = target.startsWith("https://") || ((home.finalUrl || "").startsWith("https://"));
  const noindex  = low.indexOf("noindex") !== -1;
  const stripWS = (s) => { let r = ""; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c !== 9 && c !== 32) r += s.charAt(i); } return r; };
  const robotsLines = ((robots && robots.text) || "").toLowerCase().split("\n").map(stripWS);
  const robotsOk = robots.ok && !robotsLines.includes("disallow:/");
  const sitemapText = (sitemap && sitemap.text) || "";
  const sitemapOk = sitemap.ok && (sitemapText.indexOf("<urlset") !== -1 || sitemapText.indexOf("<sitemapindex") !== -1);
  let b5pts = 0;
  if (hasTitle) b5pts += 2;
  if (hasDesc)  b5pts += 2;
  if (hasOg)    b5pts += 2;
  if (hasCanon) b5pts += 2;
  if (isHttps && !noindex)   b5pts += 1;
  if (robotsOk || sitemapOk) b5pts += 1;
  let b5state = "none";
  if (b5pts >= 8) b5state = "full";
  else if (b5pts >= 4) b5state = "partial";
  const bySignal = {
    ownedSite:         { state: b1state, points: b1pts, max: 8,  meta: { status: home.status } },
    llmsTxt:           { state: b2state, points: b2pts, max: 14, meta: { length: llmsBody.length, file: llms.ok ? "llms.txt" : (llmsFull.ok ? "llms-full.txt" : null) } },
    structuredData:    { state: b3state, points: b3pts, max: 14, meta: { types: sd.types, name: sd.name || "" } },
    sameAsCrossVerify: { state: b4state, points: b4pts, max: 14, meta: { matches: crossMatches, siteSameAs: [...sameAsHosts], profileHosts: [...profileHosts] } },
    pageBasics:        { state: b5state, points: b5pts, max: 10, meta: { hasTitle, hasDesc, hasOg, hasCanon, isHttps: isHttps && !noindex, crawlable: robotsOk || sitemapOk } }
  };
  return { bySignal, total: b1pts + b2pts + b3pts + b4pts + b5pts };
}
function layerBToSignals(lb) {
  return [
    { id:"site",         layer:"B", ...lb.ownedSite },
    { id:"llms",         layer:"B", ...lb.llmsTxt },
    { id:"schema",       layer:"B", ...lb.structuredData },
    { id:"sameas_xref",  layer:"B", ...lb.sameAsCrossVerify },
    { id:"basics",       layer:"B", ...lb.pageBasics }
  ];
}
function layerBPlaceholderSignals() {
  return [
    { id:"site",        layer:"B", state:"none", points:0, max:8,  meta:{ noSite:true } },
    { id:"llms",        layer:"B", state:"none", points:0, max:14, meta:{ noSite:true } },
    { id:"schema",      layer:"B", state:"none", points:0, max:14, meta:{ noSite:true } },
    { id:"sameas_xref", layer:"B", state:"none", points:0, max:14, meta:{ noSite:true } },
    { id:"basics",      layer:"B", state:"none", points:0, max:10, meta:{ noSite:true } }
  ];
}

/* Helpers */
async function serper(query, country, env) {
  try {
    const res = await withTimeout(fetch("https://google.serper.dev/search", {
      method:"POST",
      headers:{ "X-API-KEY": env.SERPER_API_KEY, "Content-Type":"application/json" },
      body: JSON.stringify({ q: query, gl: (country && country !== "__" ? country.toLowerCase() : "us"), num: 10 })
    }));
    if (!res.ok) return { ok:false };
    const data = await res.json();
    return { ok:true, data };
  } catch (e) { return { ok:false }; }
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
  if (data.knowledgeGraph && Array.isArray(data.knowledgeGraph.profiles)) {
    for (const p of data.knowledgeGraph.profiles) {
      const plat = classifyHost(p.link);
      if (plat && !seen.has(plat + "|" + hostOf(p.link))) {
        profiles.push({ platform: plat, url: p.link, title: p.name || "", fromKG: true });
        seen.add(plat + "|" + hostOf(p.link));
      }
    }
  }
  return profiles;
}
function pickCandidate(data, name) {
  if (data.knowledgeGraph && data.knowledgeGraph.website) {
    const u = normalizeUrl(data.knowledgeGraph.website);
    if (u && !isThirdParty(u)) return { url: u, title: data.knowledgeGraph.title || hostOf(u), snippet: data.knowledgeGraph.description || "", source: "knowledgeGraph" };
  }
  const organic = Array.isArray(data.organic) ? data.organic : [];
  const candidates = organic.filter(r => r.link && !isThirdParty(r.link));
  if (!candidates.length) return null;
  const slug = (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (slug.length >= 3) {
    for (const r of candidates) {
      const host = hostOf(r.link);
      const parts = host.split(".");
      const rootName = parts.slice(0, Math.max(1, parts.length - 1)).join("");
      if (rootName === slug || rootName.indexOf(slug) !== -1 || slug.indexOf(rootName) !== -1) {
        return { url: normalizeUrl(r.link), title: r.title || host, snippet: r.snippet || "", source: "nameMatch" };
      }
    }
  }
  const r = candidates[0];
  return { url: normalizeUrl(r.link), title: r.title || hostOf(r.link), snippet: r.snippet || "", source: "organic" };
}
function estimateMatches(data, name) {
  const organic = Array.isArray(data.organic) ? data.organic : [];
  if (!organic.length) return 1;
  const nm = (name || "").toLowerCase();
  const titleHits = organic.filter(o => ((o.title || "") + " " + (o.snippet || "")).toLowerCase().includes(nm)).length;
  const distinctHosts = new Set(organic.map(o => hostOf(o.link)).filter(Boolean));
  return Math.max(1, Math.min(distinctHosts.size, Math.round(titleHits / 1.5)) || 1);
}
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
    if (typeof n === "object") { flat.push(n); if (n["@graph"]) walk(n["@graph"]); }
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
  return { hasEntity, hasDescription, hasImage, types:[...new Set(types)], name, sameAs:[...new Set(sameAs)] };
}
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
      redirect:"follow",
      headers:{ "User-Agent":"EverybodyKnowsYou-DiscoverabilityBot/1.0 (+https://everybodyknowsyou.com)" }
    }));
    const text = res.ok ? await res.text() : "";
    return { ok: res.ok, status: res.status, text: text.slice(0, 400000), finalUrl: res.url };
  } catch (e) { return { ok:false, status:0, text:"", finalUrl:url }; }
}
function withTimeout(promise) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), FETCH_TIMEOUT))]);
}
