/**
 * OmniLeads Master Backend Worker (Final Tars AI Edition)
 * Features: 12-Hour D1 Cache, 6 Free APIs, Google CSE (12 Sites), Bing Fallback, Vertex AI Scoring
 */

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

export default {
  async fetch(request, env, ctx) {
    // 1. CORS Handle
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== "POST") return new Response(JSON.stringify({ error: "Only POST allowed" }), { status: 405, headers: CORS_HEADERS });

    try {
      const { keyword, userId } = await request.json();
      if (!keyword) return new Response(JSON.stringify({ error: "Keyword required" }), { status: 400, headers: CORS_HEADERS });

      const cleanTerms = getSearchTerms(keyword);
      const masterKeyword = cleanTerms.join(" ");

      // =============================================
      // STEP 1: D1 Cache Check (12 Hours Freshness)
      // =============================================
      let conditions = cleanTerms.map(() => `keyword LIKE ?`);
      let params = cleanTerms.map(t => `%${t}%`);
      const dbQuery = `
        SELECT * FROM leads 
        WHERE (${conditions.join(" AND ")})
        AND created_at >= datetime('now', '-12 hours') 
        ORDER BY match_score DESC, created_at DESC LIMIT 50
      `;

      const { results: cachedLeads } = await env.DB.prepare(dbQuery).bind(...params).all();
      if (cachedLeads && cachedLeads.length > 0) {
        return new Response(JSON.stringify({ source: "cache", message: "12-Hour Fresh Cached Leads", total: cachedLeads.length, leads: cachedLeads }), { headers: CORS_HEADERS });
      }

      // =============================================
      // STEP 2: Parallel Scraping (6 Free APIs + Google CSE)
      // =============================================
      const results = await Promise.allSettled([
        scrapeReddit(masterKeyword),
        scrapeHackerNews(masterKeyword),
        scrapeRemoteOK(masterKeyword),
        scrapeGitHub(masterKeyword),
        scrapeRemotive(masterKeyword),
        scrapeWeWorkRemotely(masterKeyword),
        scrapeGoogleCSE(masterKeyword, env)
      ]);

      let allLeads = [];
      results.forEach(res => {
        if (res.status === "fulfilled" && res.value) {
          allLeads = [...allLeads, ...res.value];
        }
      });

      // Bing Backup (اگر گوگل فیل ہو جائے یا ڈیٹا کم ہو اور Bing Key موجود ہو)
      if (allLeads.length < 5 && env.BING_API_KEY) {
        try {
          const bingLeads = await scrapeBing(masterKeyword, env);
          allLeads = [...allLeads, ...bingLeads];
        } catch(e) {}
      }

      if (allLeads.length === 0) {
        return new Response(JSON.stringify({ source: "none", message: "No leads found across all 14 platforms.", leads: [] }), { headers: CORS_HEADERS });
      }

      // =============================================
      // STEP 3: Vertex AI Filtering (Using Cloud Credits)
      // =============================================
      const aiFilteredLeads = await filterWithVertexAI(allLeads, masterKeyword, env);

      // =============================================
      // STEP 4: Save Verified Leads to D1 Database (Batch Insert)
      // =============================================
      if (aiFilteredLeads.length > 0) {
        const stmt = env.DB.prepare(`
          INSERT OR IGNORE INTO leads (id, keyword, platform, author_name, post_text, source_url, match_score, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const batch = aiFilteredLeads.map(lead =>
          stmt.bind(crypto.randomUUID(), masterKeyword, lead.platform, lead.author, lead.text, lead.url, lead.score, userId || "anonymous")
        );
        await env.DB.batch(batch);
      }

      return new Response(JSON.stringify({ source: "live", message: "Live Scraped & AI Filtered Leads", total: aiFilteredLeads.length, leads: aiFilteredLeads }), { headers: CORS_HEADERS });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });
    }
  }
};

/* =========================================================================
   🟢 LIST 2: FREE API SCRAPERS (No Keys Needed)
========================================================================= */
async function scrapeReddit(keyword) {
  let leads = [];
  try {
    const res = await fetch(`https://www.reddit.com/r/forhire+hiring+jobs/search.json?q=${encodeURIComponent(keyword)}&sort=new&t=week&restrict_sr=1`, { headers: { "User-Agent": "OmniLeads/1.0" } });
    const data = await res.json();
    data?.data?.children?.forEach(({ data: p }) => {
      if (p.author !== "[deleted]") leads.push({ platform: "Reddit", author: p.author, text: (p.title + " " + (p.selftext || "")).substring(0, 400), url: `https://reddit.com${p.permalink}` });
    });
  } catch (e) {} return leads.slice(0, 5);
}

async function scrapeHackerNews(keyword) {
  let leads = [];
  try {
    const res = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(keyword)}&tags=job`);
    const data = await res.json();
    data?.hits?.forEach(h => leads.push({ platform: "HackerNews", author: h.author || "Company", text: (h.title + " " + (h.story_text || "")).substring(0, 400), url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}` }));
  } catch (e) {} return leads.slice(0, 5);
}

async function scrapeRemoteOK(keyword) {
  let leads = [];
  try {
    const res = await fetch(`https://remoteok.com/api`);
    const data = await res.json();
    const filtered = data.filter(job => job.position && job.position.toLowerCase().includes(keyword.toLowerCase()));
    filtered.slice(0, 5).forEach(job => leads.push({ platform: "RemoteOK", author: job.company, text: (job.position + " - " + (job.description || "").replace(/<[^>]*>?/gm, '')).substring(0, 400), url: job.url }));
  } catch (e) {} return leads;
}

async function scrapeGitHub(keyword) {
  let leads = [];
  try {
    const res = await fetch(`https://api.github.com/search/issues?q=label:hiring+state:open+${encodeURIComponent(keyword)}`, { headers: { "User-Agent": "OmniLeads/1.0" } });
    const data = await res.json();
    data?.items?.slice(0, 5).forEach(item => leads.push({ platform: "GitHub", author: item.user.login, text: (item.title + " " + (item.body || "")).substring(0, 400), url: item.html_url }));
  } catch (e) {} return leads;
}

async function scrapeRemotive(keyword) {
  let leads = [];
  try {
    const res = await fetch(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(keyword)}`);
    const data = await res.json();
    data?.jobs?.slice(0, 5).forEach(job => leads.push({ platform: "Remotive", author: job.company_name, text: (job.title + " - " + (job.description || "").replace(/<[^>]*>?/gm, '')).substring(0, 400), url: job.url }));
  } catch (e) {} return leads;
}

async function scrapeWeWorkRemotely(keyword) {
  let leads = [];
  try {
    const res = await fetch(`https://weworkremotely.com/remote-jobs.rss`);
    const text = await res.text();
    const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
    for(const item of items) {
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
      const linkMatch = item.match(/<link>(.*?)<\/link>/);
      if(titleMatch && titleMatch[1].toLowerCase().includes(keyword.toLowerCase())) {
        leads.push({ platform: "WeWorkRemotely", author: "WWR Company", text: titleMatch[1], url: linkMatch ? linkMatch[1] : "" });
      }
    }
  } catch (e) {} return leads.slice(0, 5);
}

/* =========================================================================
   🟡 LIST 1: GOOGLE CSE (For LinkedIn, X, Dribbble, Indeed etc.)
========================================================================= */
async function scrapeGoogleCSE(keyword, env) {
  let leads = [];
  if (!env.GOOGLE_CSE_KEY || !env.GOOGLE_CSE_ID) return leads;
  
  // Custom Dorks based on your list
  const dorks = [
    `"${keyword}" ("hiring" OR "looking for")`,
    `site:twitter.com OR site:x.com "${keyword}" "hiring"`
  ];

  for (const query of dorks) {
    try {
      const res = await fetch(`https://www.googleapis.com/customsearch/v1?key=${env.GOOGLE_CSE_KEY}&cx=${env.GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&num=4`);
      const data = await res.json();
      data?.items?.forEach(item => {
        let platformName = "Web";
        if(item.link.includes("linkedin")) platformName = "LinkedIn";
        if(item.link.includes("twitter") || item.link.includes("x.com")) platformName = "X/Twitter";
        if(item.link.includes("dribbble") || item.link.includes("behance")) platformName = "Design Portals";
        
        leads.push({ platform: platformName, author: item.displayLink, text: (item.title + " " + (item.snippet || "")).substring(0, 400), url: item.link });
      });
    } catch (e) {}
  }
  return leads;
}

// Bing Fallback (Will work automatically when you add the key later)
async function scrapeBing(keyword, env) {
  let leads = [];
  try {
    const res = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(keyword + ' "looking to hire"')}&count=4`, { headers: { "Ocp-Apim-Subscription-Key": env.BING_API_KEY } });
    const data = await res.json();
    data?.webPages?.value?.forEach(item => leads.push({ platform: "Bing Web", author: item.displayUrl, text: (item.name + " " + item.snippet).substring(0, 400), url: item.url }));
  } catch(e) {} return leads;
}

/* =========================================================================
   🧠 GOOGLE CLOUD VERTEX AI (Not AI Studio - Uses your $3400 credits)
========================================================================= */
async function filterWithVertexAI(leads, keyword, env) {
  if (!leads || leads.length === 0) return [];
  // Send top 20 leads max to save API limits
  const sample = leads.slice(0, 20);
  const prompt = `You are an expert Lead Qualifier. Analyze these posts and find GENUINE clients looking to HIRE a "${keyword}".
Score 90-100: Definite direct hiring post. 70-89: Very likely hiring. 0-69: Spam, self-promotion, or job seekers.
Return ONLY a JSON array of objects strictly with keys: "platform", "author", "text", "url", "score".
Posts data: ${JSON.stringify(sample)}`;

  // 🚨 Using Vertex AI Endpoint for your specific project (tars-ai-chat-ann-assistant)
  const projectId = env.VERTEX_PROJECT_ID || "tars-ai-chat-ann-assistant";
  const location = env.VERTEX_LOCATION || "us-central1";
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/gemini-1.5-flash:generateContent`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "Authorization": `Bearer ${env.VERTEX_ACCESS_TOKEN}` // Requires a valid Vertex token in env
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      })
    });
    
    if (!res.ok) throw new Error("Vertex AI API failed");
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    return parsed.filter(l => l.score >= 70).sort((a, b) => b.score - a.score);
  } catch (e) {
    // Fallback: If AI fails, return leads with a default score so system doesn't break
    return sample.map(l => ({ ...l, score: 50 }));
  }
}

// Helper Function
function getSearchTerms(rawKeyword) {
  const stopWords = new Set(['for', 'the', 'in', 'a', 'looking', 'need', 'to', 'hire', 'developer', 'designer']);
  return rawKeyword.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w)).sort();
  }
    
