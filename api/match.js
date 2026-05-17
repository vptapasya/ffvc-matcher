// api/match.js — takes pre-scraped jobs + resume, returns ranked matches
const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  let resume = "", jobs = [];
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    resume = body.resume || "";
    jobs = body.jobs || [];
  } catch {
    res.status(400).json({ error: "Invalid request body" }); return;
  }

  if (!resume.trim()) { res.status(400).json({ error: "Resume required" }); return; }
  if (!jobs.length)   { res.status(400).json({ error: "No jobs provided" }); return; }

  // Keyword pre-filter: keep top 50 most relevant jobs
  const resumeWords = new Set(
    (resume.toLowerCase().match(/\b[a-z]{3,}\b/g) || []).filter(w => w.length > 3)
  );

  const jobScores = jobs.map((job, i) => {
    const text = `${job.title} ${job.type} ${job.description || ""}`.toLowerCase();
    let hits = 0;
    resumeWords.forEach(w => { if (text.includes(w)) hits++; });
    return { i, hits };
  });

  jobScores.sort((a, b) => b.hits - a.hits);
  const topJobs = jobScores.slice(0, 50).map(s => jobs[s.i]);

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

Return ONLY valid JSON with no markdown:
{
  "summary": "2-3 sentence candidate profile",
  "skills": ["skill1", "skill2"],
  "matches": [
    { "id": <number>, "score": <0-100>, "reason": "<one sentence>", "matchedSkills": ["skill1"] }
  ]
}

Include ALL ${topJobs.length} jobs. Sort by score descending.`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 6000,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = msg.content[0].text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const result = JSON.parse(raw);

    const enriched = (result.matches || []).map(m => {
      const job = topJobs[m.id] || {};
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

    res.status(200).json({
      summary: result.summary,
      skills: result.skills,
      matches: enriched,
    });
  } catch (err) {
    console.error("Match error:", err);
    res.status(500).json({ error: err.message });
  }
};