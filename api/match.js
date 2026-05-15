// api/match.js — FFVC Job Matcher serverless function
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
  if (/greenhouse\.io/i.test(url))  return "greenhouse";
  if (/lever\.co/i.test(url))       return "lever";
  if (/ashbyhq\.com/i.test(url))    return "ashby";
  if (/workable\.com/i.test(url))   return "workable";
  if (/breezy\.hr/i.test(url))      return "breezy";
  if (/bamboohr\.com/i.test(url))   return "bamboohr";
  if (/peopleforce\.io/i.test(url)) return "peopleforce";
  if (/jobs\.gem\.com/i.test(url))  return "gem";
  return "html";
}

// ─── ATS fetchers ─────────────────────────────────────────────────────────────

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

function extractSlug(url, atsType) {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (atsType === "greenhouse") return parts[0];
    if (atsType === "lever")      return parts[0];
    if (atsType === "ashby")      return parts[0];
    if (atsType === "workable")   return parts[0];
    if (atsType === "breezy")     return u.hostname.split(".")[0];
    if (atsType === "bamboohr")   return u.hostname.split(".")[0];
    if (atsType === "gem")        return parts[0];
    if (atsType === "peopleforce") return u.hostname.split(".")[0];
  } catch {}
  return null;
}

function mapDept(team) {
  if (!team) return "Other";
  const t = team.toLowerCase();
  if (t.includes("engineer") || t.includes("eng") || t.includes("dev") || t.includes("software")) return "Engineering";
  if (t.includes("product")) return "Product";
  if (t.includes("design") || t.includes("ux") || t.includes("ui")) return "Design";
  if (t.includes("sales") || t.includes("revenue") || t.includes("account")) return "Sales";
  if (t.includes("data") || t.includes("analytics") || t.includes("ml") || t.includes("ai")) return "Data";
  if (t.includes("market")) return "Marketing";
  if (t.includes("ops") || t.includes("operations") || t.includes("finance") || t.includes("legal") || t.includes("hr") || t.includes("people")) return "Operations";
  return "Other";
}

async function fetchGreenhouseJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "greenhouse");
  if (!slug) throw new Error("No Greenhouse slug");
  const data = await fetchJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return (data.jobs || []).map((j) => ({
    title: j.title,
    location: (j.location && j.location.name) || "",
    type: mapDept(j.departments && j.departments[0] && j.departments[0].name),
    description: j.content ? cheerio.load(j.content).text().slice(0, 300) : "",
    link: j.absolute_url || careersUrl,
  }));
}

async function fetchLeverJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "lever");
  if (!slug) throw new Error("No Lever slug");
  const data = await fetchJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return (Array.isArray(data) ? data : []).map((j) => ({
    title: j.text,
    location: (j.categories && j.categories.location) || "",
    type: mapDept(j.categories && j.categories.team),
    description: (j.descriptionPlain || "").slice(0, 300),
    link: j.hostedUrl || careersUrl,
  }));
}

async function fetchAshbyJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "ashby");
  if (!slug) throw new Error("No Ashby slug");
  const data = await fetchJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return (data.jobPostings || data.jobs || []).map((j) => ({
    title: j.title,
    location: j.location || j.locationName || "",
    type: mapDept(j.department || j.team || ""),
    description: (j.descriptionPlain || j.description || "").replace(/<[^>]+>/g, "").slice(0, 300),
    link: j.jobUrl || j.applyUrl || careersUrl,
  }));
}

async function fetchWorkableJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "workable");
  if (!slug) throw new Error("No Workable slug");
  const data = await fetchJSON(`https://apply.workable.com/api/v3/accounts/${slug}/jobs`);
  return (data.results || []).map((j) => ({
    title: j.title,
    location: [j.city, j.country].filter(Boolean).join(", "),
    type: mapDept(j.department || ""),
    description: (j.description || "").replace(/<[^>]+>/g, "").slice(0, 300),
    link: `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
  }));
}

async function fetchBreezyJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "breezy");
  if (!slug) throw new Error("No Breezy slug");
  const data = await fetchJSON(`https://${slug}.breezy.hr/json`);
  return (Array.isArray(data) ? data : []).map((j) => ({
    title: j.name,
    location: (j.location && j.location.name) || "",
    type: mapDept(j.department || ""),
    description: "",
    link: `https://${slug}.breezy.hr/p/${j.friendly_id}`,
  }));
}

async function fetchBambooJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "bamboohr");
  if (!slug) throw new Error("No BambooHR slug");
  // Use the public-facing careers JSON endpoint
  const data = await fetchJSON(`https://${slug}.bamboohr.com/careers/list`);
  const jobs = data.result || data || [];
  return (Array.isArray(jobs) ? jobs : []).map((j) => ({
    title: j.jobOpeningName || j.title || "",
    location: j.location || "",
    type: mapDept(j.department || ""),
    description: "",
    link: `https://${slug}.bamboohr.com/careers/${j.id}` || careersUrl,
  }));
}

async function fetchPeopleforceJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "peopleforce");
  if (!slug) throw new Error("No Peopleforce slug");
  const data = await fetchJSON(`https://${slug}.peopleforce.io/api/v1/vacancies`);
  const jobs = data.data || data || [];
  return (Array.isArray(jobs) ? jobs : []).map((j) => ({
    title: j.title || j.name || "",
    location: j.location || j.city || "",
    type: mapDept(j.department || ""),
    description: (j.description || "").replace(/<[^>]+>/g, "").slice(0, 300),
    link: j.url || careersUrl,
  }));
}

// ─── HTML fallback ────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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
  const selectors = ["[class*='job']","[class*='career']","[class*='position']","[class*='opening']","[class*='role']","main","article","#content",".content"];
  let text = "";
  for (const sel of selectors) {
    const el = $(sel);
    if (el.length) text += el.text() + "\n";
  }
  if (!text.trim()) text = $("body").text();
  return text.replace(/\s+/g, " ").trim().slice(0, 12000);
}

// ─── Main scrape dispatcher ───────────────────────────────────────────────────

async function scrapeCompany(company) {
  const { name, careersUrl } = company;

  if (LINKEDIN_RE.test(careersUrl)) {
    return { company: name, skipped: true, reason: "LinkedIn URL — manual review required" };
  }

  const ats = detectATS(careersUrl);

  if (ats !== "html") {
    try {
      let jobs = [];
      if (ats === "greenhouse")      jobs = await fetchGreenhouseJobs(careersUrl);
      else if (ats === "lever")      jobs = await fetchLeverJobs(careersUrl);
      else if (ats === "ashby")      jobs = await fetchAshbyJobs(careersUrl);
      else if (ats === "workable")   jobs = await fetchWorkableJobs(careersUrl);
      else if (ats === "breezy")     jobs = await fetchBreezyJobs(careersUrl);
      else if (ats === "bamboohr")   jobs = await fetchBambooJobs(careersUrl);
      else if (ats === "peopleforce") jobs = await fetchPeopleforceJobs(careersUrl);
      else {
        const html = await fetchPage(careersUrl);
        return { company: name, careersUrl, ats, text: extractTextFromHtml(html) };
      }
      return { company: name, careersUrl, ats, structuredJobs: jobs.map(j => ({ ...j, company: name })) };
    } catch (err) {
      console.error(`ATS API failed for ${name} (${ats}): ${err.message} — falling back to HTML`);
      // fall through to HTML
    }
  }

  try {
    const html = await fetchPage(careersUrl);
    return { company: name, careersUrl, ats: "html", text: extractTextFromHtml(html) };
  } catch (err) {
    return { company: name, error: err.message };
  }
}

// ─── AI: Job Extraction (HTML only) ──────────────────────────────────────────

async function extractJobsFromText(company, text, careersUrl) {
  const prompt = `Extract all job listings from this careers page content for company "${company}".
Return ONLY a valid JSON array: [{"title":"...","location":"...","type":"...","description":"...","link":"..."}]
Type must be one of: Engineering, Product, Design, Sales, Operations, Data, Marketing, Other
For link: use full URL if found, otherwise use "${careersUrl}"
Return [] if no jobs found. No markdown, no explanation.

CONTENT:
${text}`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = msg.content[0].text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const jobs = JSON.parse(raw);
    return Array.isArray(jobs) ? jobs.map((j) => ({ ...j, company })) : [];
  } catch {
    return [];
  }
}

// ─── AI: Resume Matching ──────────────────────────────────────────────────────

async function matchResumeToJobs(resume, allJobs) {
  // Keyword pre-filter: score every job by resume keyword overlap, keep top 50
  const resumeWords = new Set(
    (resume.toLowerCase().match(/\b[a-z]{3,}\b/g) || []).filter(w => w.length > 3)
  );

  const jobScores = allJobs.map((job, i) => {
    const text = `${job.title} ${job.type} ${job.description || ""}`.toLowerCase();
    let hits = 0;
    resumeWords.forEach(w => { if (text.includes(w)) hits++; });
    return { i, hits };
  });

  jobScores.sort((a, b) => b.hits - a.hits);
  const top50Indexes = jobScores.slice(0, 50).map(s => s.i);
  const topJobs = top50Indexes.map(i => allJobs[i]);

  const jobsJson = JSON.stringify(
    topJobs.map((j, i) => ({
      id: i,
      title: j.title,
      company: j.company,
      location: j.location || "",
      type: j.type || "",
      description: (j.description || "").slice(0, 200),
    }))
  );

  const prompt = `You are a recruiter at a top VC firm. Analyze this resume against these job listings.

RESUME:
${resume.slice(0, 4000)}

JOBS (JSON):
${jobsJson}

Return ONLY valid JSON with no markdown fences:
{
  "summary": "2-3 sentence candidate profile",
  "skills": ["skill1", "skill2"],
  "matches": [
    {
      "id": <number>,
      "score": <0-100>,
      "reason": "<one sentence>",
      "matchedSkills": ["skill1"]
    }
  ]
}

Include ALL ${topJobs.length} jobs. Sort matches by score descending.`;

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 6000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = msg.content[0].text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  const result = JSON.parse(raw);

  // Remap ids back to actual job objects
  result.matches = (result.matches || []).map(m => ({
    ...m,
    _job: topJobs[m.id] || {},
  }));

  return result;
}

// ─── SSE helper ───────────────────────────────────────────────────────────────

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
    // 1. Load companies
    sendEvent(res, "status", { step: "sheets", message: "Reading company list from Google Sheets…" });
    let companies;
    try {
      companies = await getCompanies();
    } catch (err) {
      sendEvent(res, "error", { message: `Failed to read Google Sheet: ${err.message}` });
      res.end();
      return;
    }

    // 2. Scrape all in parallel
    sendEvent(res, "status", { step: "scraping", message: `Found ${companies.length} active companies. Fetching careers pages…`, total: companies.length });

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

    // 3. Extract jobs
    sendEvent(res, "status", { step: "extracting", message: "Extracting job listings…" });

    const jobArrays = await Promise.all(
      scrapeResults.map(async (r) => {
        if (r.skipped) return [{ company: r.company, skipped: true, reason: r.reason }];
        if (r.error)   return [];
        if (r.structuredJobs) return r.structuredJobs;
        if (r.text)    return extractJobsFromText(r.company, r.text, r.careersUrl);
        return [];
      })
    );

    const allJobs    = jobArrays.flat();
    const realJobs   = allJobs.filter(j => !j.skipped);
    const skippedJobs = allJobs.filter(j => j.skipped);

    sendEvent(res, "status", {
      step: "matching",
      message: `Found ${realJobs.length} open positions across ${companies.length} companies. Running AI match…`,
      jobCount: realJobs.length,
    });

    // 4. Match
    let matchResult;
    if (realJobs.length === 0) {
      matchResult = { summary: "No open positions found.", skills: [], matches: [] };
    } else {
      matchResult = await matchResumeToJobs(resume, realJobs);
    }

    // 5. Build enriched results
    const enrichedMatches = (matchResult.matches || []).map(m => {
      const job = m._job || {};
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
    console.error("Handler error:", err);
    sendEvent(res, "error", { message: err.message });
  }

  res.end();
};