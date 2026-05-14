// api/match.js — FFVC Job Matcher serverless function
// Handles: Google Sheets read → parallel scrape → AI extraction → AI matching

const fetch = require("node-fetch");
const cheerio = require("cheerio");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Google Sheets ────────────────────────────────────────────────────────────

async function getGoogleSheetsToken() {
  const { google } = require("googleapis");
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const token = await auth.getAccessToken();
  return token.token;
}

async function getCompanies() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const token = await getGoogleSheetsToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:E`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
  const data = await res.json();
  const rows = data.values || [];
  if (rows.length < 2) return [];
  return rows
    .slice(1)
    .filter((r) => (r[4] || "").toString().toUpperCase().trim() === "Y")
    .map((r) => ({ name: r[0] || "", website: r[1] || "", careersUrl: r[2] || "", stage: r[3] || "" }))
    .filter((c) => c.name && c.careersUrl);
}

// ─── ATS detection ────────────────────────────────────────────────────────────

const LINKEDIN_RE = /linkedin\.com/i;
const TIMEOUT_MS = 15000;

function detectATS(url) {
  if (/greenhouse\.io/i.test(url))   return "greenhouse";
  if (/lever\.co/i.test(url))        return "lever";
  if (/ashbyhq\.com/i.test(url))     return "ashby";
  if (/workable\.com/i.test(url))    return "workable";
  if (/breezy\.hr/i.test(url))       return "breezy";
  if (/bamboohr\.com/i.test(url))    return "bamboohr";
  if (/peopleforce\.io/i.test(url))  return "peopleforce";
  if (/jobs\.gem\.com/i.test(url))   return "gem";
  return "html";
}

// ─── ATS-specific fetchers ────────────────────────────────────────────────────

async function fetchJSON(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FFVCJobMatcher/1.0)", Accept: "application/json", ...headers },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Extract slug from URL for various ATS
function extractSlug(url, atsType) {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (atsType === "greenhouse") {
      // https://job-boards.greenhouse.io/addepar1  → addepar1
      // https://boards.greenhouse.io/addepar1      → addepar1
      return parts[0];
    }
    if (atsType === "lever") {
      // https://jobs.lever.co/company → company
      return parts[0];
    }
    if (atsType === "ashby") {
      // https://jobs.ashbyhq.com/rescale → rescale
      return parts[0];
    }
    if (atsType === "workable") {
      // https://apply.workable.com/manna-1/ → manna-1
      return parts[0];
    }
    if (atsType === "breezy") {
      // https://barn2door-inc.breezy.hr/ → barn2door-inc (subdomain)
      return u.hostname.split(".")[0];
    }
    if (atsType === "bamboohr") {
      // https://rhinolabs.bamboohr.com/careers → rhinolabs
      return u.hostname.split(".")[0];
    }
    if (atsType === "gem") {
      // https://jobs.gem.com/civrobotics-com → civrobotics-com
      return parts[0];
    }
    if (atsType === "peopleforce") {
      // https://respeecher.peopleforce.io/careers → respeecher
      return u.hostname.split(".")[0];
    }
  } catch {}
  return null;
}

async function fetchGreenhouseJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "greenhouse");
  if (!slug) throw new Error("Could not extract Greenhouse slug");
  const data = await fetchJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return (data.jobs || []).map((j) => ({
    title: j.title,
    location: (j.location && j.location.name) || "",
    type: "Other",
    description: j.content ? cheerio.load(j.content).text().slice(0, 300) : "",
    link: j.absolute_url || careersUrl,
  }));
}

async function fetchLeverJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "lever");
  if (!slug) throw new Error("Could not extract Lever slug");
  const data = await fetchJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return (Array.isArray(data) ? data : []).map((j) => ({
    title: j.text,
    location: (j.categories && j.categories.location) || "",
    type: mapLeverDept(j.categories && j.categories.team),
    description: (j.descriptionPlain || "").slice(0, 300),
    link: j.hostedUrl || careersUrl,
  }));
}

function mapLeverDept(team) {
  if (!team) return "Other";
  const t = team.toLowerCase();
  if (t.includes("engineer") || t.includes("eng") || t.includes("dev")) return "Engineering";
  if (t.includes("product")) return "Product";
  if (t.includes("design")) return "Design";
  if (t.includes("sales") || t.includes("revenue")) return "Sales";
  if (t.includes("data") || t.includes("analytics")) return "Data";
  if (t.includes("market")) return "Marketing";
  if (t.includes("ops") || t.includes("operations")) return "Operations";
  return "Other";
}

async function fetchAshbyJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "ashby");
  if (!slug) throw new Error("Could not extract Ashby slug");
  const data = await fetchJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return ((data.jobPostings || data.jobs || [])).map((j) => ({
    title: j.title,
    location: (j.location || j.locationName || ""),
    type: mapLeverDept(j.department || j.team || ""),
    description: (j.descriptionPlain || j.description || "").slice(0, 300),
    link: j.jobUrl || j.applyUrl || careersUrl,
  }));
}

async function fetchWorkableJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "workable");
  if (!slug) throw new Error("Could not extract Workable slug");
  const data = await fetchJSON(`https://apply.workable.com/api/v3/accounts/${slug}/jobs`, {
    "Content-Type": "application/json",
  });
  return ((data.results || [])).map((j) => ({
    title: j.title,
    location: [j.city, j.country].filter(Boolean).join(", "),
    type: mapLeverDept(j.department || ""),
    description: (j.description || "").replace(/<[^>]+>/g, "").slice(0, 300),
    link: `https://apply.workable.com/${slug}/j/${j.shortcode}/` || careersUrl,
  }));
}

async function fetchBreezyJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "breezy");
  if (!slug) throw new Error("Could not extract Breezy slug");
  const data = await fetchJSON(`https://${slug}.breezy.hr/json`);
  return (Array.isArray(data) ? data : []).map((j) => ({
    title: j.name,
    location: (j.location && j.location.name) || "",
    type: mapLeverDept(j.department || ""),
    description: "",
    link: `https://${slug}.breezy.hr/p/${j.friendly_id}` || careersUrl,
  }));
}

async function fetchBambooJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "bamboohr");
  if (!slug) throw new Error("Could not extract BambooHR slug");
  const data = await fetchJSON(`https://api.bamboohr.com/api/gateway.php/${slug}/v1/applicant_tracking/jobs`, {
    Accept: "application/json",
  });
  // BambooHR public jobs endpoint
  const jobs = data.result || data || [];
  return (Array.isArray(jobs) ? jobs : []).map((j) => ({
    title: j.jobOpening && j.jobOpening.jobOpeningName || j.title || "",
    location: j.location && j.location.city || "",
    type: mapLeverDept(j.department || ""),
    description: "",
    link: careersUrl,
  }));
}

// Fallback: scrape HTML
async function fetchPage(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FFVCJobMatcher/1.0; +https://ffvc.com)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function extractTextFromHtml(html) {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, [aria-hidden='true']").remove();
  const jobSelectors = ["[class*='job']","[class*='career']","[class*='position']","[class*='opening']","[class*='role']","main","article","#content",".content"];
  let text = "";
  for (const sel of jobSelectors) {
    const el = $(sel);
    if (el.length) text += el.text() + "\n";
  }
  if (!text.trim()) text = $("body").text();
  return text.replace(/\s+/g, " ").trim().slice(0, 12000);
}

function findNextPageUrl(html, baseUrl) {
  const $ = cheerio.load(html);
  const nextLink = $("a[rel='next'], a:contains('Next'), a:contains('next'), .pagination a[href]")
    .filter((_, el) => {
      const text = $(el).text().toLowerCase().trim();
      return text === "next" || text === "next page" || $(el).attr("rel") === "next";
    })
    .first().attr("href");
  if (!nextLink) return null;
  try { return new URL(nextLink, baseUrl).href; } catch { return null; }
}

// ─── Main scrape dispatcher ───────────────────────────────────────────────────

async function scrapeCompany(company) {
  const { name, careersUrl } = company;

  if (LINKEDIN_RE.test(careersUrl)) {
    return { company: name, jobs: [], skipped: true, reason: "LinkedIn URL — manual review required" };
  }

  const ats = detectATS(careersUrl);

  // ATS API path — returns structured jobs directly, skip AI extraction
  if (ats !== "html") {
    try {
      let jobs = [];
      if (ats === "greenhouse")  jobs = await fetchGreenhouseJobs(careersUrl);
      else if (ats === "lever")  jobs = await fetchLeverJobs(careersUrl);
      else if (ats === "ashby")  jobs = await fetchAshbyJobs(careersUrl);
      else if (ats === "workable") jobs = await fetchWorkableJobs(careersUrl);
      else if (ats === "breezy") jobs = await fetchBreezyJobs(careersUrl);
      else if (ats === "bamboohr") jobs = await fetchBambooJobs(careersUrl);
      // gem + peopleforce fall through to HTML scrape
      else {
        const html = await fetchPage(careersUrl);
        return { company: name, careersUrl, ats, text: extractTextFromHtml(html), pages: 1 };
      }
      // Return pre-structured jobs (bypass AI extraction)
      return { company: name, careersUrl, ats, structuredJobs: jobs.map(j => ({ ...j, company: name })) };
    } catch (err) {
      // Fall back to HTML scrape on API failure
      console.error(`ATS API failed for ${name} (${ats}): ${err.message} — falling back to HTML`);
    }
  }

  // HTML scrape path
  const allText = [];
  let url = careersUrl;
  let pages = 0;
  try {
    while (url && pages < 10) {
      const html = await fetchPage(url);
      allText.push(extractTextFromHtml(html));
      const next = findNextPageUrl(html, url);
      url = next !== url ? next : null;
      pages++;
    }
  } catch (err) {
    return { company: name, jobs: [], error: err.message };
  }
  const combinedText = allText.join("\n---PAGE BREAK---\n").slice(0, 20000);
  return { company: name, careersUrl, ats: "html", text: combinedText, pages };
}

// ─── AI: Job Extraction (HTML fallback only) ──────────────────────────────────

async function extractJobsFromText(company, text, careersUrl) {
  const prompt = `Extract all job listings from this careers page content for company "${company}".
Return ONLY valid JSON array: [{"title":"...","location":"...","type":"...","description":"...","link":"..."}]
Type must be one of: Engineering, Product, Design, Sales, Operations, Data, Marketing, Other
For link: use full URL if found, otherwise use "${careersUrl}"
Return [] if no jobs found. No markdown, no explanation.

CONTENT:
${text}`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = msg.content[0].text.trim();
    const clean = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const jobs = JSON.parse(clean);
    return Array.isArray(jobs) ? jobs.map((j) => ({ ...j, company })) : [];
  } catch {
    return [];
  }
}

// ─── AI: Resume Matching ──────────────────────────────────────────────────────

async function matchResumeToJobs(resume, allJobs) {
  const jobsJson = JSON.stringify(
    allJobs.map((j, i) => ({ id: i, title: j.title, company: j.company, location: j.location, type: j.type, description: (j.description || "").slice(0, 300) }))
  );

  const prompt = `You are a recruiter at a top VC firm. Analyze this resume against these job listings.

RESUME:
${resume.slice(0, 6000)}

JOBS (JSON):
${jobsJson}

Return ONLY valid JSON (no markdown):
{
  "summary": "2-3 sentence candidate profile",
  "skills": ["skill1", "skill2", ...],
  "matches": [
    {
      "id": <job id from input>,
      "score": <0-100>,
      "reason": "<one sentence why this is a match or mismatch>",
      "matchedSkills": ["skill1", ...]
    }
  ]
}

Include ALL jobs in matches array, sorted by score descending. Be precise and honest about fit.`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = msg.content[0].text.trim();
  const clean = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  // Repair truncated JSON by finding the last complete match object
  try {
    return JSON.parse(clean);
  } catch {
    const lastGood = clean.lastIndexOf('},');
    if (lastGood === -1) throw new Error("Could not parse match results");
    const repaired = clean.slice(0, lastGood + 1) + ']}}';
    try {
      return JSON.parse(repaired);
    } catch {
      // Try to extract just what we have
      const summaryMatch = clean.match(/"summary"\s*:\s*"([^"]+)"/);
      const skillsMatch = clean.match(/"skills"\s*:\s*(\[[^\]]+\])/);
      const matchesEnd = clean.lastIndexOf('},');
      const matchesStr = matchesEnd > -1 ? clean.slice(clean.indexOf('"matches"') + 11, matchesEnd + 1) + ']' : '[]';
      return {
        summary: summaryMatch ? summaryMatch[1] : "Profile analyzed.",
        skills: skillsMatch ? JSON.parse(skillsMatch[1]) : [],
        matches: JSON.parse(matchesStr) || []
      };
    }
  }
}

// ─── Streaming SSE helper ────────────────────────────────────────────────────

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  let resume = "";
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    resume = body.resume || "";
  } catch {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  if (!resume.trim()) { res.status(400).json({ error: "Resume is required" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.status(200);

  try {
    sendEvent(res, "status", { step: "sheets", message: "Reading company list from Google Sheets…" });
    let companies;
    try {
      companies = await getCompanies();
    } catch (err) {
      sendEvent(res, "error", { message: `Failed to read Google Sheet: ${err.message}` });
      res.end();
      return;
    }

    sendEvent(res, "status", { step: "scraping", message: `Found ${companies.length} active companies. Scraping careers pages…`, total: companies.length });

    let completed = 0;
    const scrapeResults = await Promise.all(
      companies.map(async (company) => {
        const result = await scrapeCompany(company);
        completed++;
        sendEvent(res, "progress", {
          company: company.name,
          completed,
          total: companies.length,
          skipped: !!result.skipped,
          error: result.error || null,
          ats: result.ats || null,
        });
        return result;
      })
    );

    sendEvent(res, "status", { step: "extracting", message: "Extracting job listings…" });

    const jobArrays = await Promise.all(
      scrapeResults.map(async (r) => {
        if (r.skipped) return [{ company: r.company, title: "LinkedIn listing", skipped: true, reason: r.reason, link: companies.find(c => c.name === r.company)?.careersUrl }];
        if (r.error) return [];
        // ATS API returned structured jobs — no AI extraction needed
        if (r.structuredJobs) return r.structuredJobs;
        // HTML path — use AI extraction
        if (r.text) return extractJobsFromText(r.company, r.text, r.careersUrl);
        return [];
      })
    );

    const allJobs = jobArrays.flat();
    const realJobs = allJobs.filter((j) => !j.skipped);
    const skippedJobs = allJobs.filter((j) => j.skipped);

    sendEvent(res, "status", {
      step: "matching",
      message: `Found ${realJobs.length} open positions across ${companies.length} companies. Running AI match…`,
      jobCount: realJobs.length,
    });

    let matchResult;
    if (realJobs.length === 0) {
      matchResult = { summary: "No open positions found.", skills: [], matches: [] };
    } else {
      matchResult = await matchResumeToJobs(resume, realJobs);
    }

    const enrichedMatches = (matchResult.matches || []).map((m) => {
      const job = realJobs[m.id] || {};
      return {
        title: job.title,
        company: job.company,
        location: job.location,
        type: job.type,
        link: job.link,
        score: m.score,
        reason: m.reason,
        matchedSkills: m.matchedSkills || [],
      };
    });

    sendEvent(res, "result", {
      summary: matchResult.summary,
      skills: matchResult.skills,
      matches: enrichedMatches,
      skipped: skippedJobs,
      companiesScraped: companies.length,
      jobsFound: realJobs.length,
    });

    sendEvent(res, "done", {});
  } catch (err) {
    sendEvent(res, "error", { message: err.message });
  }

  res.end();
};