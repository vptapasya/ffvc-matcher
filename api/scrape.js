// api/scrape.js — fetches all jobs from all companies, returns structured list
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
const TIMEOUT_MS = 12000;

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
  } catch (err) { clearTimeout(timer); throw err; }
}

function extractSlug(url, atsType) {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (atsType === "breezy" || atsType === "bamboohr" || atsType === "peopleforce")
      return u.hostname.split(".")[0];
    return parts[0];
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
  if (t.includes("ops") || t.includes("operations") || t.includes("finance") || t.includes("hr") || t.includes("people")) return "Operations";
  return "Other";
}

async function fetchGreenhouseJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "greenhouse");
  if (!slug) throw new Error("No slug");
  const data = await fetchJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return (data.jobs || []).map(j => ({
    title: j.title, location: (j.location && j.location.name) || "",
    type: mapDept(j.departments && j.departments[0] && j.departments[0].name),
    description: j.content ? cheerio.load(j.content).text().slice(0, 300) : "",
    link: j.absolute_url || careersUrl,
  }));
}

async function fetchLeverJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "lever");
  if (!slug) throw new Error("No slug");
  const data = await fetchJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return (Array.isArray(data) ? data : []).map(j => ({
    title: j.text, location: (j.categories && j.categories.location) || "",
    type: mapDept(j.categories && j.categories.team),
    description: (j.descriptionPlain || "").slice(0, 300),
    link: j.hostedUrl || careersUrl,
  }));
}

async function fetchAshbyJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "ashby");
  if (!slug) throw new Error("No slug");
  const data = await fetchJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return (data.jobPostings || data.jobs || []).map(j => ({
    title: j.title, location: j.location || j.locationName || "",
    type: mapDept(j.department || j.team || ""),
    description: (j.descriptionPlain || j.description || "").replace(/<[^>]+>/g, "").slice(0, 300),
    link: j.jobUrl || j.applyUrl || careersUrl,
  }));
}

async function fetchWorkableJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "workable");
  if (!slug) throw new Error("No slug");
  const data = await fetchJSON(`https://apply.workable.com/api/v3/accounts/${slug}/jobs`);
  return (data.results || []).map(j => ({
    title: j.title, location: [j.city, j.country].filter(Boolean).join(", "),
    type: mapDept(j.department || ""),
    description: (j.description || "").replace(/<[^>]+>/g, "").slice(0, 300),
    link: `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
  }));
}

async function fetchBreezyJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "breezy");
  if (!slug) throw new Error("No slug");
  const data = await fetchJSON(`https://${slug}.breezy.hr/json`);
  return (Array.isArray(data) ? data : []).map(j => ({
    title: j.name, location: (j.location && j.location.name) || "",
    type: mapDept(j.department || ""), description: "",
    link: `https://${slug}.breezy.hr/p/${j.friendly_id}`,
  }));
}

async function fetchBambooJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "bamboohr");
  if (!slug) throw new Error("No slug");
  const data = await fetchJSON(`https://${slug}.bamboohr.com/careers/list`);
  const jobs = data.result || data || [];
  return (Array.isArray(jobs) ? jobs : []).map(j => ({
    title: j.jobOpeningName || j.title || "",
    location: j.location || "", type: mapDept(j.department || ""), description: "",
    link: `https://${slug}.bamboohr.com/careers/${j.id}`,
  }));
}

async function fetchPeopleforceJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "peopleforce");
  if (!slug) throw new Error("No slug");
  const data = await fetchJSON(`https://${slug}.peopleforce.io/api/v1/vacancies`);
  const jobs = data.data || data || [];
  return (Array.isArray(jobs) ? jobs : []).map(j => ({
    title: j.title || j.name || "", location: j.location || j.city || "",
    type: mapDept(j.department || ""),
    description: (j.description || "").replace(/<[^>]+>/g, "").slice(0, 300),
    link: j.url || careersUrl,
  }));
}

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
  } catch (err) { clearTimeout(timer); throw err; }
}

function extractTextFromHtml(html) {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header").remove();
  const selectors = ["[class*='job']","[class*='career']","[class*='position']","[class*='opening']","main","article","#content",".content"];
  let text = "";
  for (const sel of selectors) {
    const el = $(sel);
    if (el.length) text += el.text() + "\n";
  }
  if (!text.trim()) text = $("body").text();
  return text.replace(/\s+/g, " ").trim().slice(0, 10000);
}

async function extractJobsFromHtml(company, text, careersUrl) {
  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: `Extract all job listings for company "${company}". Return ONLY a JSON array: [{"title":"...","location":"...","type":"Engineering|Product|Design|Sales|Operations|Data|Marketing|Other","description":"...","link":"..."}]. Use "${careersUrl}" if no link found. Return [] if none. No markdown.\n\nCONTENT:\n${text}` }],
    });
    const raw = msg.content[0].text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const jobs = JSON.parse(raw);
    return Array.isArray(jobs) ? jobs.map(j => ({ ...j, company })) : [];
  } catch { return []; }
}

async function scrapeCompany(company) {
  const { name, careersUrl } = company;
  if (LINKEDIN_RE.test(careersUrl)) return { company: name, skipped: true, reason: "LinkedIn URL — manual review required" };

  const ats = detectATS(careersUrl);
  if (ats !== "html") {
    try {
      let jobs = [];
      if (ats === "greenhouse")       jobs = await fetchGreenhouseJobs(careersUrl);
      else if (ats === "lever")       jobs = await fetchLeverJobs(careersUrl);
      else if (ats === "ashby")       jobs = await fetchAshbyJobs(careersUrl);
      else if (ats === "workable")    jobs = await fetchWorkableJobs(careersUrl);
      else if (ats === "breezy")      jobs = await fetchBreezyJobs(careersUrl);
      else if (ats === "bamboohr")    jobs = await fetchBambooJobs(careersUrl);
      else if (ats === "peopleforce") jobs = await fetchPeopleforceJobs(careersUrl);
      return { company: name, ats, structuredJobs: jobs.map(j => ({ ...j, company: name })) };
    } catch (err) {
      console.error(`ATS failed for ${name}: ${err.message}`);
    }
  }

  try {
    const html = await fetchPage(careersUrl);
    const text = extractTextFromHtml(html);
    const jobs = await extractJobsFromHtml(name, text, careersUrl);
    return { company: name, ats: "html", structuredJobs: jobs };
  } catch (err) {
    return { company: name, error: err.message, structuredJobs: [] };
  }
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.status(200);

  try {
    sendEvent(res, "status", { message: "Reading company list…" });
    let companies;
    try {
      companies = await getCompanies();
    } catch (err) {
      sendEvent(res, "error", { message: `Failed to read Google Sheet: ${err.message}` });
      res.end(); return;
    }

    sendEvent(res, "status", { message: `Found ${companies.length} companies. Fetching jobs…`, total: companies.length });

    // Scrape in batches of 8 to stay well under timeout
    const BATCH = 8;
    const allJobs = [];
    const skipped = [];
    let completed = 0;

    for (let i = 0; i < companies.length; i += BATCH) {
      const batch = companies.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(c => scrapeCompany(c)));

      for (const r of results) {
        completed++;
        if (r.skipped) {
          skipped.push({ company: r.company, reason: r.reason });
        } else {
          allJobs.push(...(r.structuredJobs || []));
        }
        sendEvent(res, "progress", {
          company: r.company,
          completed,
          total: companies.length,
          jobsFound: (r.structuredJobs || []).length,
          skipped: !!r.skipped,
          error: r.error || null,
        });
      }
    }

    sendEvent(res, "jobs", {
      jobs: allJobs,
      skipped,
      companiesScraped: companies.length,
      jobsFound: allJobs.length,
    });

    sendEvent(res, "done", {});
  } catch (err) {
    console.error("Scrape error:", err);
    sendEvent(res, "error", { message: err.message });
  }

  res.end();
};