const fetch = require("node-fetch");
const cheerio = require("cheerio");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = "claude-sonnet-4.6";

// ─── HELPER: STRIP CONVERSATION FROM JSON ─────────────────────────────────────
function cleanJSON(text) {
  try {
    // Finds the first '{' or '[' and the last '}' or ']'
    const start = text.indexOf('{') !== -1 ? text.indexOf('{') : text.indexOf('[');
    const end = text.lastIndexOf('}') !== -1 ? text.lastIndexOf('}') : text.lastIndexOf(']');
    if (start === -1 || end === -1) return text;
    return text.substring(start, end + 1);
  } catch (e) {
    return text;
  }
}

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────
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

// ─── SCRAPING LOGIC ───────────────────────────────────────────────────────────
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

// Logic for extracting slugs omitted for brevity, same as your previous version
function extractSlug(url, atsType) {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (atsType === "greenhouse" || atsType === "lever" || atsType === "ashby" || atsType === "workable" || atsType === "gem") return parts[0];
    if (atsType === "breezy" || atsType === "bamboohr" || atsType === "peopleforce") return u.hostname.split(".")[0];
  } catch {}
  return null;
}

// ─── AI EXTRACTION (FOR HTML PAGES) ───────────────────────────────────────────
async function extractJobsFromText(company, text, careersUrl) {
  try {
    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: "You are a JSON-only data extractor. Output ONLY a valid JSON array. No conversational text.",
      messages: [{ role: "user", content: `Extract jobs for ${company} from this text: ${text.slice(0, 8000)}` }],
    });
    return JSON.parse(cleanJSON(msg.content[0].text));
  } catch (e) {
    console.error("Extraction error:", e);
    return [];
  }
}

// ─── AI MATCHING (THE MAIN AGENT) ─────────────────────────────────────────────
async function matchResumeToJobs(resume, allJobs) {
  console.log(`Matching resume against ${allJobs.length} jobs using ${CLAUDE_MODEL}`);
  
  const prompt = `RESUME: ${resume.slice(0, 5000)}\n\nJOBS: ${JSON.stringify(allJobs.slice(0, 50))}`;
  
  try {
    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      system: "You are a recruitment AI. Output ONLY valid JSON in this format: { \"summary\": \"string\", \"skills\": [], \"matches\": [{ \"id\": 0, \"score\": 85, \"reason\": \"string\", \"matchedSkills\": [] }] }. Do not include any other text.",
      messages: [{ role: "user", content: prompt }],
    });
    
    return JSON.parse(cleanJSON(msg.content[0].text));
  } catch (e) {
    console.error("Matching error:", e);
    throw new Error("AI Matching failed to return valid data.");
  }
}

// ─── SSE STREAMING HELPERS ───────────────────────────────────────────────────
function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const resume = body.resume || "";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.status(200);

  try {
    sendEvent(res, "status", { message: "Accessing FFVC Portfolio Data..." });
    const companies = await getCompanies();
    
    // Scrape logic... (simplified for this block)
    const scrapeResults = await Promise.all(companies.map(async (c) => {
      // (Insert your scrapeCompany logic here)
      if (LINKEDIN_RE.test(c.careersUrl)) return { company: c.name, skipped: true };
      return { company: c.name, text: "Sample text" }; // Placeholder
    }));

    const allJobs = []; // This would be populated by your scrape logic
    
    sendEvent(res, "status", { message: "AI is analyzing fit..." });
    const matchResult = await matchResumeToJobs(resume, allJobs);

    sendEvent(res, "result", matchResult);
    sendEvent(res, "done", {});
  } catch (err) {
    console.error("Final Handler Error:", err.message);
    sendEvent(res, "error", { message: err.message });
  }
  res.end();
};