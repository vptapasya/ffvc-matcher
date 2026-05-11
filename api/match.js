const fetch = require("node-fetch");
const cheerio = require("cheerio");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = "claude-sonnet-4.6";

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function cleanJSON(text) {
  try {
    const start = text.indexOf('{') !== -1 ? text.indexOf('{') : text.indexOf('[');
    const end = text.lastIndexOf('}') !== -1 ? text.lastIndexOf('}') : text.lastIndexOf(']');
    if (start === -1 || end === -1) return text;
    return text.substring(start, end + 1);
  } catch (e) { return text; }
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
  return rows.slice(1)
    .filter(r => (r[4] || "").toString().toUpperCase().trim() === "Y")
    .map(r => ({ name: r[0], website: r[1], careersUrl: r[2], stage: r[3] }))
    .filter(c => c.name && c.careersUrl);
}

// ─── DEEP SCRAPER ─────────────────────────────────────────────────────────────
const LINKEDIN_RE = /linkedin\.com/i;

async function scrapeCompany(company) {
  const { name, careersUrl } = company;
  if (LINKEDIN_RE.test(careersUrl)) return { company: name, skipped: true, reason: "LinkedIn" };
  
  try {
    const res = await fetch(careersUrl, { 
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9"
      },
      redirect: 'follow',
      timeout: 10000
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    
    // Remove noise
    $("script, style, nav, footer, iframe").remove();
    
    // Target common job container patterns
    const text = $("a, h1, h2, h3, h4, li, .job, .position")
      .map((i, el) => $(el).text().trim())
      .get()
      .join(" | ")
      .slice(0, 12000); 

    return { company: name, text, careersUrl };
  } catch (e) {
    return { company: name, error: e.message };
  }
}

// ─── AI AGENTS ───────────────────────────────────────────────────────────────
async function extractJobsFromText(company, text, careersUrl) {
  if (!text || text.length < 50) return [];
  try {
    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: "You are a JSON-only extractor. Look for job titles, locations, and descriptions. If no jobs found, return []. Never include prose.",
      messages: [{ role: "user", content: `Company: ${company}\nText: ${text}` }],
    });
    const jobs = JSON.parse(cleanJSON(msg.content[0].text));
    return Array.isArray(jobs) ? jobs.map(j => ({ 
      ...j, 
      company: company, 
      link: j.link && j.link.startsWith('http') ? j.link : careersUrl 
    })) : [];
  } catch { return []; }
}

async function matchResumeToJobs(resume, allJobs) {
  if (!allJobs || allJobs.length === 0) {
    return { summary: "No active positions found in portfolio.", skills: [], matches: [] };
  }

  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    system: "You are a recruiter. Output ONLY JSON: { \"summary\": \"\", \"skills\": [], \"matches\": [{ \"id\": 0, \"score\": 0, \"reason\": \"\", \"matchedSkills\": [] }] }",
    messages: [{ role: "user", content: `RESUME: ${resume}\n\nJOBS: ${JSON.stringify(allJobs.slice(0, 50))}` }],
  });
  
  return JSON.parse(cleanJSON(msg.content[0].text));
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────
function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const resume = body.resume || "";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.status(200);

  try {
    sendEvent(res, "status", { message: "Loading FFVC Portfolio..." });
    const companies = await getCompanies();
    
    sendEvent(res, "status", { message: `Scanning ${companies.length} companies...` });
    const scrapeResults = await Promise.all(companies.map(c => scrapeCompany(c)));
    
    sendEvent(res, "status", { message: "Extracting roles..." });
    const jobArrays = await Promise.all(scrapeResults.map(r => extractJobsFromText(r.company, r.text, r.careersUrl)));

    const allJobs = jobArrays.flat().map((j, i) => ({ ...j, id: i }));
    
    sendEvent(res, "status", { message: `Analyzing ${allJobs.length} matches...` });
    const matchResult = await matchResumeToJobs(resume, allJobs);

    // Merge match scores with job details
    const enrichedMatches = (matchResult.matches || []).map(m => ({
      ...allJobs[m.id],
      ...m
    }));

    sendEvent(res, "result", {
      ...matchResult,
      matches: enrichedMatches,
      companiesScraped: companies.length,
      jobsFound: allJobs.length
    });
    
    sendEvent(res, "done", {});
  } catch (err) {
    console.error(err);
    sendEvent(res, "error", { message: err.message });
  }
  res.end();
};