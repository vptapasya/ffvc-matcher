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
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);

  const data = await res.json();
  const rows = data.values || [];
  if (rows.length < 2) return [];

  // Skip header row; columns: Name | Website | Careers URL | Stage | Active
  return rows
    .slice(1)
    .filter((r) => (r[4] || "").toString().toUpperCase().trim() === "Y")
    .map((r) => ({
      name: r[0] || "",
      website: r[1] || "",
      careersUrl: r[2] || "",
      stage: r[3] || "",
    }))
    .filter((c) => c.name && c.careersUrl);
}

// ─── Scraping ────────────────────────────────────────────────────────────────

const LINKEDIN_RE = /linkedin\.com/i;
const TIMEOUT_MS = 15000;

async function fetchPage(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; FFVCJobMatcher/1.0; +https://ffvc.com)",
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
  // Remove noise
  $("script, style, nav, footer, header, [aria-hidden='true']").remove();
  // Focus on likely job content areas
  const jobSelectors = [
    "[class*='job']",
    "[class*='career']",
    "[class*='position']",
    "[class*='opening']",
    "[class*='role']",
    "main",
    "article",
    "#content",
    ".content",
  ];
  let text = "";
  for (const sel of jobSelectors) {
    const el = $(sel);
    if (el.length) {
      text += el.text() + "\n";
    }
  }
  if (!text.trim()) text = $("body").text();
  // Collapse whitespace, limit size
  return text.replace(/\s+/g, " ").trim().slice(0, 12000);
}

// Find pagination links in an HTML page
function findNextPageUrl(html, baseUrl) {
  const $ = cheerio.load(html);
  const nextLink = $("a[rel='next'], a:contains('Next'), a:contains('next'), .pagination a[href]")
    .filter((_, el) => {
      const text = $(el).text().toLowerCase().trim();
      return text === "next" || text === "next page" || $(el).attr("rel") === "next";
    })
    .first()
    .attr("href");

  if (!nextLink) return null;
  try {
    return new URL(nextLink, baseUrl).href;
  } catch {
    return null;
  }
}

async function scrapeCompany(company) {
  const { name, careersUrl } = company;

  // Flag LinkedIn
  if (LINKEDIN_RE.test(careersUrl)) {
    return { company: name, jobs: [], skipped: true, reason: "LinkedIn URL — manual review required" };
  }

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
  return { company: name, careersUrl, text: combinedText, pages };
}

// ─── AI: Job Extraction ───────────────────────────────────────────────────────

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
      model: "claude-sonnet-4-20250514",
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
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = msg.content[0].text.trim();
  const clean = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(clean);
}

// ─── Streaming SSE helper ────────────────────────────────────────────────────

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Parse body
  let resume = "";
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    resume = body.resume || "";
  } catch {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  if (!resume.trim()) {
    res.status(400).json({ error: "Resume is required" });
    return;
  }

  // SSE headers
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

    sendEvent(res, "status", { step: "scraping", message: `Found ${companies.length} active companies. Scraping careers pages…`, total: companies.length });

    // 2. Scrape all companies in parallel
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
        });
        return result;
      })
    );

    // 3. Extract jobs from each scraped page (parallel)
    sendEvent(res, "status", { step: "extracting", message: "Extracting job listings with AI…" });

    const jobArrays = await Promise.all(
      scrapeResults.map(async (r) => {
        if (r.skipped) return [{ company: r.company, title: "LinkedIn listing", skipped: true, reason: r.reason, link: companies.find(c => c.name === r.company)?.careersUrl }];
        if (r.error || !r.text) return [];
        return extractJobsFromText(r.company, r.text, r.careersUrl);
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

    // 4. Match resume against all jobs
    let matchResult;
    if (realJobs.length === 0) {
      matchResult = { summary: "No open positions found.", skills: [], matches: [] };
    } else {
      matchResult = await matchResumeToJobs(resume, realJobs);
    }

    // Merge match data back into full job objects
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

    // 5. Send final result
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
