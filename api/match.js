const fetch = require("node-fetch");
const cheerio = require("cheerio");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = "claude-sonnet-4.6";

// Helper to strip AI conversational filler
function cleanJSON(text) {
  try {
    const start = text.indexOf('{') !== -1 ? text.indexOf('{') : text.indexOf('[');
    const end = text.lastIndexOf('}') !== -1 ? text.lastIndexOf('}') : text.lastIndexOf(']');
    if (start === -1 || end === -1) return text;
    return text.substring(start, end + 1);
  } catch (e) { return text; }
}

// ─── GOOGLE SHEETS ───
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
  const data = await res.json();
  const rows = data.values || [];
  return rows.slice(1)
    .filter(r => (r[4] || "").toString().toUpperCase() === "Y")
    .map(r => ({ name: r[0], website: r[1], careersUrl: r[2], stage: r[3] }))
    .filter(c => c.name && c.careersUrl);
}

// ─── SCRAPING & ATS ───
const LINKEDIN_RE = /linkedin\.com/i;

async function scrapeCompany(company) {
  const { name, careersUrl } = company;
  if (LINKEDIN_RE.test(careersUrl)) return { company: name, skipped: true, reason: "LinkedIn URL" };
  
  try {
    const res = await fetch(careersUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, nav, footer").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
    return { company: name, text, careersUrl };
  } catch (e) {
    return { company: name, error: e.message };
  }
}

// ─── AI AGENTS ───
async function extractJobsFromText(company, text, careersUrl) {
  try {
    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: "Return ONLY a JSON array: [{\"title\",\"location\",\"description\",\"link\"}]. No prose.",
      messages: [{ role: "user", content: `Extract jobs for ${company} from: ${text}` }],
    });
    return JSON.parse(cleanJSON(msg.content[0].text));
  } catch { return []; }
}

async function matchResumeToJobs(resume, allJobs) {
  if (allJobs.length === 0) return { summary: "No jobs found to match.", skills: [], matches: [] };

  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    system: "You are a recruitment AI. Output ONLY valid JSON. { \"summary\": \"\", \"skills\": [], \"matches\": [{ \"id\": 0, \"score\": 0, \"reason\": \"\", \"matchedSkills\": [] }] }",
    messages: [{ role: "user", content: `RESUME: ${resume}\n\nJOBS: ${JSON.stringify(allJobs)}` }],
  });
  return JSON.parse(cleanJSON(msg.content[0].text));
}

// ─── HANDLER ───
function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const resume = body.resume || "";

  res.setHeader("Content-Type", "text/event-stream");
  res.status(200);

  try {
    sendEvent(res, "status", { message: "Fetching companies..." });
    const companies = await getCompanies();
    
    sendEvent(res, "status", { message: `Scraping ${companies.length} portfolio sites...` });
    const scrapeResults = await Promise.all(companies.map(c => scrapeCompany(c)));
    
    sendEvent(res, "status", { message: "Extracting job details..." });
    const jobArrays = await Promise.all(scrapeResults.map(r => {
      if (r.text) return extractJobsFromText(r.company, r.text, r.careersUrl);
      return [];
    }));

    const allJobs = jobArrays.flat().map((j, i) => ({ ...j, id: i }));
    
    sendEvent(res, "status", { message: `Matching your profile against ${allJobs.length} roles...` });
    const matchResult = await matchResumeToJobs(resume, allJobs);

    const enrichedMatches = (matchResult.matches || []).map(m => ({ ...allJobs[m.id], ...m }));

    sendEvent(res, "result", { ...matchResult, matches: enrichedMatches, companiesScraped: companies.length, jobsFound: allJobs.length });
    sendEvent(res, "done", {});
  } catch (err) {
    sendEvent(res, "error", { message: err.message });
  }
  res.end();
};