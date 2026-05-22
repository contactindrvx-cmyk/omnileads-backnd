/**
 * OmniLeads Master Backend Worker (Final Tars AI Edition)
 * Sources: Reddit + HackerNews + Google CSE + Bing Search
 * AI Filter: Gemini API (Billed to your GCP Credits)
 * Database: Cloudflare D1
 */

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-goog-api-key"
};

export default {
  async fetch(request, env, ctx) {
    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Only POST requests allowed" }), { status: 405, headers: CORS_HEADERS });
    }

    try {
      const { keyword, userId } = await request.json();

      if (!keyword || keyword.trim().length === 0) {
        return new Response(JSON.stringify({ error: "Keyword is required" }), { status: 400, headers: CORS_HEADERS });
      }

      const cleanTerms = getSearchTerms(keyword);
      if (cleanTerms.length === 0) {
        return new Response(JSON.stringify({ error: "Invalid keyword provided" }), { status: 400, headers: CORS_HEADERS });
      }

      const masterKeyword = cleanTerms.join(" ");

      // =============================================
      // STEP 1: Database (D1) Cache چیک کریں
      // =============================================
      let conditions = cleanTerms.map(() => `keyword LIKE ?`);
      let params = cleanTerms.map(t => `%${t}%`);

      const dbQuery = `
        SELECT * FROM leads 
        WHERE (${conditions.join(" AND ")})
        AND created_at >= datetime('now', '-3 days')
        ORDER BY match_score DESC, created_at DESC 
        LIMIT 50
      `;

      const { results: cachedLeads } = await env.DB.prepare(dbQuery).bind(...params).all();

      if (cachedLeads && cachedLeads.length > 0) {
        return new Response(JSON.stringify({
          source: "cache",
          message: "Fetched from D1 Database",
          total: cachedLeads.length,
          leads: cachedLeads
        }), { headers: CORS_HEADERS });
      }

      // =============================================
      // STEP 2: تمام Sources سے ڈیٹا سکریپ کریں
      // =============================================
      const [redditLeads, hnLeads, googleLeads] = await Promise.allSettled([
        scrapeReddit(masterKeyword),
        scrapeHackerNews(masterKeyword),
        scrapeGoogleCSE(masterKeyword, env)
      ]);

      let allLeads = [
        ...(redditLeads.status === "fulfilled" ? redditLeads.value : []),
        ...(hnLeads.status  === "fulfilled" ? hnLeads.value  : []),
        ...(googleLeads.status === "fulfilled" ? googleLeads.value : [])
      ];

      // Backup: اگر لیڈز کم ہوں تو Bing استعمال کریں
      if (allLeads.length < 5) {
        try {
          const bingLeads = await scrapeBing(masterKeyword, env);
          allLeads = [...allLeads, ...bingLeads];
        } catch(e) {
          console.error("Bing backup failed", e);
        }
      }

      if (allLeads.length === 0) {
        return new Response(JSON.stringify({
          source: "none",
          message: "No leads found across platforms.",
          leads: []
        }), { headers: CORS_HEADERS });
      }

      // =============================================
      // STEP 3: AI Filtering (Gemini/Vertex)
      // =============================================
      const aiFilteredLeads = await filterWithGemini(allLeads, masterKeyword, env);

      // =============================================
      // STEP 4: Save to Database (D1)
      // =============================================
      if (aiFilteredLeads.length > 0) {
        const stmt = env.DB.prepare(`
          INSERT OR IGNORE INTO leads 
            (id, keyword, platform, author_name, post_text, source_url, match_score, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const batch = aiFilteredLeads.map(lead =>
          stmt.bind(
            crypto.randomUUID(),
            masterKeyword,
            lead.platform,
            lead.author,
            lead.text,
            lead.url,
            lead.score,
            userId || "anonymous"
          )
        );

        await env.DB.batch(batch);
      }

      return new Response(JSON.stringify({
        source: "live",
        message: "Scraped and AI Filtered successfully",
        total: aiFilteredLeads.length,
        leads: aiFilteredLeads
      }), { headers: CORS_HEADERS });

    } catch (error) {
      console.error("Worker Error:", error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });
    }
  }
};

/* =========================================================================
   SCRAPERS (Reddit, HackerNews, Google, Bing)
========================================================================= */
async function scrapeReddit(keyword) {
  const leads = [];
  const subreddits = ["forhire", "hiring", "freelance", "jobs"];
  for (const sub of subreddits) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(keyword)}&sort=new&t=week&restrict_sr=1`, { headers: { "User-Agent": "OmniLeads/3.0" } });
      if (!res.ok) continue;
      const data = await res.json();
      data?.data?.children?.forEach(({ data: post }) => {
        if (post.author !== "[deleted]") {
          leads.push({ platform: `Reddit/r/${sub}`, author: post.author, text: (post.title + " " + (post.selftext || "")).slice(0, 500), url: `https://reddit.com${post.permalink}` });
        }
      });
    } catch (e) {}
  }
  return leads;
}

async function scrapeHackerNews(keyword) {
  const leads = [];
  try {
    const res = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(keyword)}&tags=ask_hn,job&hitsPerPage=10`);
    if (!res.ok) return leads;
    const data = await res.json();
    data?.hits?.forEach(hit => {
      leads.push({ platform: "HackerNews", author: hit.author || "unknown", text: (hit.title + " " + (hit.story_text || "")).slice(0, 500), url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}` });
    });
  } catch (e) {}
  return leads;
}

async function scrapeGoogleCSE(keyword, env) {
  const leads = [];
  if (!env.GOOGLE_CSE_KEY || !env.GOOGLE_CSE_ID) return leads;
  const dorks = [`site:linkedin.com/in "${keyword}" "open to work" OR "hiring"`, `site:facebook.com/groups "${keyword}" "looking for"`];
  for (const query of dorks) {
    try {
      const res = await fetch(`https://www.googleapis.com/customsearch/v1?key=${env.GOOGLE_CSE_KEY}&cx=${env.GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&num=3`);
      if (!res.ok) continue;
      const data = await res.json();
      data?.items?.forEach(item => {
        leads.push({ platform: item.link.includes("linkedin") ? "LinkedIn" : "Facebook", author: item.displayLink || "unknown", text: (item.title + " " + (item.snippet || "")).slice(0, 500), url: item.link });
      });
    } catch (e) {}
  }
  return leads;
}

async function scrapeBing(keyword, env) {
  const leads = [];
  if (!env.BING_API_KEY) return leads;
  const queries = [`${keyword} "looking to hire" OR "need a"`, `site:linkedin.com "${keyword}" hiring`];
  for (const query of queries) {
    try {
      const res = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=3`, { headers: { "Ocp-Apim-Subscription-Key": env.BING_API_KEY } });
      if (!res.ok) continue;
      const data = await res.json();
      data?.webPages?.value?.forEach(item => {
        leads.push({ platform: item.url.includes("linkedin") ? "LinkedIn" : "Bing Web", author: item.displayUrl || "unknown", text: (item.name + " " + item.snippet).slice(0, 500), url: item.url });
      });
    } catch(e) {}
  }
  return leads;
}

/* =========================================================================
   AI FILTER: Google API (Simple & Secure via x-goog-api-key)
========================================================================= */
async function filterWithGemini(leads, keyword, env) {
  if (!leads || leads.length === 0) return [];
  const sample = leads.slice(0, 15);
  const prompt = `You are an expert Lead Qualifier. Analyze these posts and find GENUINE clients looking to HIRE someone for "${keyword}".
Scoring rules: 90-100: Clear hire intent, 70-89: Likely hiring, 0-69: Spam/Vague.
Return ONLY a valid JSON array of objects with keys: "platform", "author", "text", "url", "score".
Posts: ${JSON.stringify(sample)}`;

  // یہ سادہ اور سیکیور API اینڈپوائنٹ ہے جو آپ کی GCP کی کے ساتھ کام کرے گا
  const model = "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "x-goog-api-key": env.VERTEX_API_KEY // <-- آپ کے سکرین شاٹ والی Key یہاں آئے گی
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      })
    });

    if (!res.ok) throw new Error("AI filter failed");
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    return parsed.filter(lead => lead.score >= 70).sort((a, b) => b.score - a.score);
  } catch (e) {
    console.error("AI Error:", e.message);
    return sample.map(l => ({ ...l, score: 50 }));
  }
}

function getSearchTerms(rawKeyword) {
  const stopWords = new Set(['for', 'the', 'in', 'a', 'an', 'looking', 'need', 'want', 'to', 'hire', 'please', 'help']);
  return rawKeyword.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w)).sort();
                                      }
                  
