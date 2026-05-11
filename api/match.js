// api/match.js — FFVC Job Matcher serverless function
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Use a stable, high-performing model ID
const CLAUDE_MODEL = "claude-sonnet-4-6";

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
    if (atsType === "lever") return parts[0];
    if (atsType === "ashby") return parts[0];
    if (atsType === "workable") return parts[0];
    if (atsType === "breezy") return u.hostname.split(".")[0];
    if (atsType === "bamboohr") return u.hostname.split(".")[0];
    if (atsType === "gem") return parts[0];
    if (atsType === "peopleforce") return u.hostname.split(".")[0];
  } catch {}
  return null;
}

async function fetchGreenhouseJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "greenhouse");
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
  const data = await fetchJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  const jobs = data.jobPostings || data.jobs || [];
  return jobs.map((j) => ({
    title: j.title,
    location: (j.location || j.locationName || ""),
    type: mapLeverDept(j.department || j.team || ""),
    description: (j.descriptionPlain || j.description || "").slice(0, 300),
    link: j.jobUrl || j.applyUrl || careersUrl,
  }));
}

async function fetchWorkableJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "workable");
  const data = await fetchJSON(`https://apply.workable.com/api/v3/accounts/${slug}/jobs`, { "Content-Type": "application/json" });
  return (data.results || []).map((j) => ({
    title: j.title,
    location: [j.city, j.country].filter(Boolean).join(", "),
    type: mapLeverDept(j.department || ""),
    description: (j.description || "").replace(/<[^>]+>/g, "").slice(0, 300),
    link: `https://apply.workable.com/${slug}/j/${j.shortcode}/` || careersUrl,
  }));
}

async function fetchBreezyJobs(careersUrl) {
  const slug = extractSlug(careersUrl, "breezy");
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
  const data = await fetchJSON(`https://api.bamboohr.com/api/gateway.php/${slug}/v1/applicant_tracking/jobs`, { Accept: "application/json" });
  const jobs = data.result || data || [];
  return (Array.isArray(jobs) ? jobs : []).map((j) => ({
    title: j.jobOpening && j.jobOpening.jobOpeningName || j.title || "",
    location: j.location && j.location.city || "",
    type: mapLeverDept(j.department || ""),
    description: "",
    link: careersUrl,
  }));
}

async function fetchPage(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FFVCJobMatcher/1.0)", Accept: "text/html" },
      redirect: "follow",
    });
    clearTimeout(timer);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function extractTextFromHtml(html) {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header").remove();
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, 10000);
}

async function scrapeCompany(company) {
  const { name, careersUrl } = company;
  if (LINKEDIN_RE.test(careersUrl)) return { company: name, jobs: [], skipped: true, reason: "LinkedIn URL" };
  const ats = detectATS(careersUrl);
  try {
    if (ats === "greenhouse") return { company: name, careersUrl, ats, structuredJobs: await fetchGreenhouseJobs(careersUrl) };
    if (ats === "lever") return { company: name, careersUrl, ats, structuredJobs: await fetchLeverJobs(careersUrl) };
    if (ats === "ashby") return { company: name, careersUrl, ats, structuredJobs: await fetchAshbyJobs(careersUrl) };
    if (ats === "workable") return { company: name, careersUrl, ats, structuredJobs: await fetchWorkableJobs(careersUrl) };
    if (ats === "breezy") return { company: name, careersUrl, ats, structuredJobs: await fetchBreezyJobs(careersUrl) };
    if (ats === "bamboohr") return { company: name, careersUrl, ats, structuredJobs: await fetchBambooJobs(careersUrl) };
    const html = await fetchPage(careersUrl);
    return { company: name, careersUrl, ats: "html", text: extractTextFromHtml(html) };
  } catch (err) {
    return { company: name, jobs: [], error: err.message };
  }
}

async function extractJobsFromText(company, text, careersUrl) {
  const prompt = `Extract job listings for "${company}". Return JSON array: [{"title","location","type","description","link"}]`;
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt + "\n\nCONTENT:\n" + text }],
  });
  return JSON.parse(msg.content[0].text.replace(/```json|```/g, ""));
}

async function matchResumeToJobs(resume, allJobs) {
  console.log(`Calling Anthropic for matching with ${allJobs.length} jobs...`);
  const prompt = `Match resume against these jobs. Return JSON: { summary, skills, matches: [{ id, score, reason, matchedSkills }] }`;
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt + "\n\nRESUME:\n" + resume + "\n\nJOBS:\n" + JSON.stringify(allJobs) }],
  });
  return JSON.parse(msg.content[0].text.replace(/```json|```/g, ""));
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const resume = body.resume || "";

  res.setHeader("Content-Type", "text/event-stream");
  res.status(200);

  try {
    const companies = await getCompanies();
    sendEvent(res, "status", { message: `Scraping ${companies.length} companies...` });

    const scrapeResults = await Promise.all(companies.map(c => scrapeCompany(c)));
    const jobArrays = await Promise.all(scrapeResults.map(async r => {
      if (r.structuredJobs) return r.structuredJobs.map(j => ({ ...j, company: r.company }));
      if (r.text) return extractJobsFromText(r.company, r.text, r.careersUrl);
      return [];
    }));

    const allJobs = jobArrays.flat();
    const matchResult = allJobs.length ? await matchResumeToJobs(resume, allJobs) : { summary: "No jobs", skills: [], matches: [] };

    sendEvent(res, "result", {
      ...matchResult,
      matches: matchResult.matches.map(m => ({ ...allJobs[m.id], ...m })),
      companiesScraped: companies.length,
      jobsFound: allJobs.length
    });
    sendEvent(res, "done", {});
  } catch (err) {
    console.error("Function Error:", err.message);
    sendEvent(res, "error", { message: err.message });
  }
  res.end();
};