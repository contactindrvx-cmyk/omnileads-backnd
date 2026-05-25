/**
 * OmniLeads Master Backend Worker v4.0 - FINAL
 * Sources: Reddit, HackerNews, RemoteOK, Remotive, WeWorkRemotely, Google CSE, Bing Backup
 * AI: Vertex AI (Simple API Key — No OAuth, No Token)
 * Database: Cloudflare D1
 */
const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Accept"
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS Preflight (براؤزر کی سکیورٹی کے لیے)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // 2. یوزر پروفائل کی ریکوئسٹ (تاکہ سیٹنگز میں ای میل اور نام شو ہو)
    if (url.pathname.includes("/v1/me")) {
      return new Response(JSON.stringify({
        status: "success",
        user: { 
          email: "contact@omnicoresolutions.site", 
          name: "OmniLeads User" 
        }
      }), { status: 200, headers: CORS_HEADERS });
    }

        // =========================================================================
    // 2.5 نیا روٹ: AI سے ریپلائی جنریٹ کروانے کے لیے (Frontend کے لیے)
    // =========================================================================
    if (url.pathname.includes("/v1/reply") && request.method === "POST") {
      try {
        const body = await request.json();
        const lead = body.lead;

        const prompt = `You are an expert lead outreach specialist working for a freelance developer/agency.
Write a highly personalized, short, and friendly outreach message to this potential client.
DO NOT pitch any product, SaaS, or tool. Pitch human freelance services/skills.
Keep it under 3 sentences. End with a low-pressure call to action (like a 10-min chat).

Client Name/ID: ${lead.author}
Keyword searched: ${lead.keyword}
Job Post: ${lead.text}`;

        const model = "gemini-2.5-flash-lite";
        const projectId = env.VERTEX_PROJECT_ID;
        const location = env.VERTEX_LOCATION;
        const key = env.VERTEX_API_KEY;

        const apiUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

        const aiRes = await fetch(apiUrl, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key 
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }]
          })
        });

        const data = await aiRes.json();
        const aiReply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Hey! I saw your post and I have extensive experience in this area. I would love to help out. Let's chat!";

        return new Response(JSON.stringify({ reply: aiReply }), { status: 200, headers: CORS_HEADERS });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });
      }
    }
    

    
    // 3. GET اور POST دونوں چلیں گے
    if (request.method !== "POST" && request.method !== "GET") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers: CORS_HEADERS }
      );
    }

    try {
      // GET میں URL params سے، POST میں body سے keyword لیں
      let keyword, userId;
      if (request.method === "GET") {
        keyword = url.searchParams.get("keyword") || url.searchParams.get("query") || "";
        userId  = url.searchParams.get("userId") || "anonymous";
      } else {
        const body = await request.json();
        keyword = body.keyword || body.query || "";
        userId  = body.userId  || "anonymous";
      }

      if (!keyword || keyword.trim().length === 0) {
        return new Response(
          JSON.stringify({ error: "Keyword is required" }),
          { status: 400, headers: CORS_HEADERS }
        );
      }

      const cleanTerms = getSearchTerms(keyword);
      if (cleanTerms.length === 0) {
        return new Response(
          JSON.stringify({ error: "Invalid keyword" }),
          { status: 400, headers: CORS_HEADERS }
        );
      }

      const masterKeyword = cleanTerms.join(" ");
      
      // =============================================
      // STEP 1: D1 Cache Check (12 Hours)
      // =============================================
      const conditions = cleanTerms.map(() => `keyword LIKE ?`);
      const params     = cleanTerms.map(t => `%${t}%`);

      const dbQuery = `
        SELECT * FROM leads
        WHERE (${conditions.join(" AND ")})
        AND created_at >= datetime('now', '-12 hours')
        ORDER BY match_score DESC, created_at DESC
        LIMIT 50
      `;

      const { results: cachedLeads } = await env.DB.prepare(dbQuery)
        .bind(...params)
        .all();

      if (cachedLeads && cachedLeads.length > 0) {
        return new Response(JSON.stringify({
          source: "cache",
          message: "12-Hour Fresh Cached Leads",
          total: cachedLeads.length,
          leads: cachedLeads
        }), { headers: CORS_HEADERS });
      }

      // =============================================
      // STEP 2: Parallel Scraping
      // =============================================
      const results = await Promise.allSettled([
        scrapeReddit(masterKeyword),
        scrapeHackerNews(masterKeyword),
        scrapeRemoteOK(masterKeyword),
        scrapeRemotive(masterKeyword),
        scrapeDevTo(masterKeyword),  
        scrapeWeWorkRemotely(masterKeyword),
        scrapeGoogleCSE(masterKeyword, env)
      ]);

      let allLeads = [];
      results.forEach(res => {
        if (res.status === "fulfilled" && Array.isArray(res.value)) {
          allLeads = [...allLeads, ...res.value];
        }
      });

      // Bing Backup — اگر leads کم ہوں اور key موجود ہو
      if (allLeads.length < 5 && env.BING_API_KEY) {
        try {
          const bingLeads = await scrapeBing(masterKeyword, env);
          allLeads = [...allLeads, ...bingLeads];
        } catch (e) {
          console.error("Bing backup failed:", e.message);
        }
      }

      if (allLeads.length === 0) {
        return new Response(JSON.stringify({
          source: "none",
          message: "No leads found. Try a different keyword.",
          leads: []
        }), { headers: CORS_HEADERS });
      }

      // =============================================
      // STEP 3: Vertex AI Filter (Simple API Key)
      // =============================================
      const aiFilteredLeads = await filterWithVertexAI(allLeads, masterKeyword, env);

      // =============================================
      // STEP 4: Save to D1 Database
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
        message: "Live Scraped & AI Filtered Leads",
        total: aiFilteredLeads.length,
        leads: aiFilteredLeads
      }), { headers: CORS_HEADERS });

    } catch (error) {
      console.error("Worker Error:", error.message);
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: CORS_HEADERS }
      );
    }
  }
};

/* =========================================================================
   SOURCE 1: Reddit
========================================================================= */
async function scrapeReddit(keyword) {
  const leads = [];
  const subreddits = ["forhire", "hiring", "freelance", "jobs"];
  for (const sub of subreddits) {
    try {
      const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(keyword)}&sort=new&t=week&restrict_sr=1`;
      const res = await fetch(url, { headers: { "User-Agent": "OmniLeads/4.0" } });
      if (!res.ok) continue;
      const data = await res.json();
      data?.data?.children?.forEach(({ data: p }) => {
        if (p.author === "[deleted]") return;
        leads.push({
          platform: `Reddit/r/${sub}`,
          author: p.author,
          text: (p.title + " " + (p.selftext || "")).substring(0, 400),
          url: `https://reddit.com${p.permalink}`
        });
      });
    } catch (e) {
      console.error(`Reddit ${sub}:`, e.message);
    }
  }
  return leads.slice(0, 10);
}

/* =========================================================================
   SOURCE 2: Hacker News (Strict 7 days timestamp filter added)
========================================================================= */
async function scrapeHackerNews(keyword) {
  const leads = [];
  try {
    const sevenDaysAgoSeconds = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(keyword)}&tags=job&numericFilters=created_at_i>${sevenDaysAgoSeconds}&hitsPerPage=10`;
    const res = await fetch(url);
    if (!res.ok) return leads;
    const data = await res.json();
    data?.hits?.forEach(h => {
      leads.push({
        platform: "HackerNews", author: h.author || "Company",
        text: (h.title + " " + (h.story_text || "")).substring(0, 400),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`
      });
    });
  } catch (e) {}
  return leads.slice(0, 8);
}

/* =========================================================================
   SOURCE 3: RemoteOK
========================================================================= */
async function scrapeRemoteOK(keyword) {
  const leads = [];
  try {
    const tag = keyword.split(" ")[0];
    const res = await fetch(`https://remoteok.com/api?tag=${encodeURIComponent(tag)}`, { headers: { "User-Agent": "OmniLeads/4.1" } });
    if (!res.ok) return leads;
    const data = await res.json();
    const jobs = Array.isArray(data) ? data.slice(1) : [];
    
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    jobs.slice(0, 6).forEach(job => {
      if (!job.position) return;
      if (job.date && new Date(job.date).getTime() < cutoff) return; // 7 دن پرانا ہٹا دو
      leads.push({
        platform: "RemoteOK", author: job.company || "Unknown",
        text: (job.position + " — " + (job.description || "").replace(/<[^>]*>/gm, "")).substring(0, 400),
        url: job.url || ""
      });
    });
  } catch (e) {}
  return leads;
}

/* =========================================================================
   SOURCE 4: Remotive
========================================================================= */
async function scrapeRemotive(keyword) {
  const leads = [];
  try {
    const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(keyword)}&limit=10`;
    const res = await fetch(url);
    if (!res.ok) return leads;
    const data = await res.json();
    
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    data?.jobs?.forEach(job => {
      if (job.publication_date && new Date(job.publication_date).getTime() < cutoff) return; // 7 دن پرانا ہٹا دو
      leads.push({
        platform: "Remotive", author: job.company_name || "Unknown",
        text: (job.title + " — " + (job.description || "").replace(/<[^>]*>/gm, "")).substring(0, 400),
        url: job.url || ""
      });
    });
  } catch (e) {}
  return leads.slice(0, 6);
}

/* =========================================================================
   SOURCE 5: WeWorkRemotely
========================================================================= */
async function scrapeWeWorkRemotely(keyword) {
  const leads = [];
  try {
    const res = await fetch(`https://weworkremotely.com/remote-jobs.rss`, { headers: { "User-Agent": "OmniLeads/4.0" } });
    if (!res.ok) return leads;
    const text = await res.text();
    const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const item of items) {
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
      const linkMatch = item.match(/<link>(.*?)<\/link>/);
      
      if (titleMatch && titleMatch[1].toLowerCase().includes(keyword.toLowerCase())) {
        leads.push({
          platform: "WeWorkRemotely", author: "WWR",
          text: titleMatch[1], url: linkMatch ? linkMatch[1] : "https://weworkremotely.com"
        });
      }
    }
  } catch (e) {}
  return leads.slice(0, 5);
}

/* =========================================================================
   SOURCE 6: Dev.to
========================================================================= */
async function scrapeDevTo(keyword) {
  const leads = [];
  try {
    const res = await fetch(`https://dev.to/api/articles?tag=hiring&per_page=10`, { headers: { "User-Agent": "OmniLeads/4.1" } });
    if (!res.ok) return leads;
    const data = await res.json();
    
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    data.filter(a => a.title.toLowerCase().includes(keyword.toLowerCase()) || (a.description || "").toLowerCase().includes(keyword.toLowerCase()))
      .forEach(a => {
        if (a.published_at && new Date(a.published_at).getTime() < cutoff) return; // 7 دن پرانا ہٹا دو
        leads.push({
          platform: "Dev.to", author: a.user?.name || "Unknown",
          text: (a.title + " " + (a.description || "")).substring(0, 400),
          url: a.url || `https://dev.to${a.path}`
        });
      });
  } catch (e) {}
  return leads.slice(0, 5);
}

/* =========================================================================
   SOURCE 7: Google CSE (FIXED: dateRestrict=w added)
========================================================================= */
async function scrapeGoogleCSE(keyword, env) {
  let leads = [];
  if (!env.GOOGLE_CSE_KEY || !env.GOOGLE_CSE_ID) return leads;

  const dorks = [
    `site:linkedin.com/posts "${keyword}" "looking for" OR "hiring" OR "need"`,
    `site:x.com OR site:twitter.com "${keyword}" "hiring" OR "need a"`,
    `site:facebook.com/groups "${keyword}" "hiring" OR "looking for"`,
    `site:quora.com "${keyword}" "looking for" OR "need to hire"`,
    `site:indiehackers.com "${keyword}" "looking for" OR "hiring"`,
    `site:producthunt.com/discussions "${keyword}" "looking for" OR "need"`
  ];

  const fetchPromises = dorks.map(async (query) => {
    try {
      // ✅ dateRestrict=w لگا دیا گیا ہے تاکہ صرف پچھلے 7 دن کا ڈیٹا آئے
      const url = `https://www.googleapis.com/customsearch/v1?key=${env.GOOGLE_CSE_KEY}&cx=${env.GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&dateRestrict=w&num=10`;
      const res = await fetch(url);
      if (!res.ok) return [];
      
      const data = await res.json();
      const localLeads = [];
      
      data?.items?.forEach(item => {
        const platform =
          item.link.includes("linkedin")      ? "LinkedIn"      :
          item.link.includes("twitter") ||
          item.link.includes("x.com")         ? "X/Twitter"     :
          item.link.includes("facebook")      ? "Facebook"      :
          item.link.includes("quora")         ? "Quora"         :
          item.link.includes("indiehackers")  ? "IndieHackers"  :
          item.link.includes("producthunt")   ? "ProductHunt"   : "Web";
          
        localLeads.push({
          platform, author: item.displayLink || "unknown",
          text: (item.title + " " + (item.snippet || "")).substring(0, 400),
          url: item.link
        });
      });
      return localLeads;
    } catch (e) { return []; }
  });

  const allResults = await Promise.all(fetchPromises);
  allResults.forEach(resArray => { leads = [...leads, ...resArray]; });
  return leads;
}

/* =========================================================================
   SOURCE 8: Bing Search (FIXED: freshness=Week added)
========================================================================= */
async function scrapeBing(keyword, env) {
  const leads = [];
  const queries = [
    `${keyword} "looking to hire" OR "need a"`,
    `site:linkedin.com "${keyword}" hiring`,
    `site:facebook.com "${keyword}" "looking for"`
  ];
  for (const query of queries) {
    try {
      // ✅ freshness=Week لگا دیا گیا ہے
      const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&freshness=Week&count=4`;
      const res = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": env.BING_API_KEY } });
      if (!res.ok) continue;
      const data = await res.json();
      data?.webPages?.value?.forEach(item => {
        const platform = item.url.includes("linkedin") ? "LinkedIn" : item.url.includes("facebook") ? "Facebook" : "Bing Web";
        leads.push({
          platform, author: item.displayUrl || "unknown",
          text: (item.name + " " + item.snippet).substring(0, 400), url: item.url
        });
      });
    } catch (e) {}
  }
  return leads;
    }
                                               

/* =========================================================================
   AI FILTER: Google Cloud Vertex AI (Uses your Cloud Credits)
========================================================================= */
async function filterWithVertexAI(leads, keyword, env) {
  if (!leads || leads.length === 0) return [];

  const sample = leads.slice(0, 50);
  const prompt = `You are an expert Lead Qualifier for freelancers and agencies.
Analyze these posts and find GENUINE clients looking to HIRE someone for "${keyword}".

STRICT RULES:
- If the author is posting their own CV, portfolio, or asking for a job -> SCORE MUST BE 0.
- If it's a promotional blog post, tutorial, or SaaS tool pitch -> SCORE MUST BE 0.
- If the author is asking a question, seeking advice, or discussing a problem related to the keyword (warm lead) -> SCORE 50-69.
- If the author is explicitly looking to hire, pay, or find an expert -> SCORE 70-100.

Return ONLY a valid JSON array. No markdown, no extra text.
Each object must have exactly these keys: "platform", "author", "text", "url", "score"

Posts: ${JSON.stringify(sample)}`;

  const model = "gemini-2.5-flash-lite"; 
  const projectId = env.VERTEX_PROJECT_ID; 
  const location = env.VERTEX_LOCATION; 
  const key = env.VERTEX_API_KEY;

  const apiUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: prompt }]
        }]
      })
    });

    if (!res.ok) {
      console.error("Vertex AI Error:", await res.text());
      return []; 
    }

    const data   = await res.json();
    const text   = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

    // یہاں 70 کی جگہ 50 کر دیا گیا ہے تاکہ 'وارم لیڈز' بھی پاس ہو سکیں
    return parsed
      .filter(l => l.score >= 50)
      .sort((a, b) => b.score - a.score);

  } catch (e) {
    console.error("Vertex AI filter failed:", e.message);
    return []; 
  }
}



/* =========================================================================
   UTILITY: Smart Keyword Extractor (Dumb-Proof Logic)
========================================================================= */
function getSearchTerms(rawKeyword) {
  let cleanText = rawKeyword.toLowerCase();
  
  // یہ وہ فالتو الفاظ ہیں جو ناسمجھ یوزرز اکثر ٹائپ کرتے ہیں
  const garbageWords = [
    "i am a", "i am", "im", "looking for a", "looking for", "looking",
    "need a", "need", "want to", "want", "hire me", "hire",
    "someone who can", "someone to", "someone", "can anyone",
    "help me", "help", "find a", "find", "job", "jobs", "work",
    "freelance", "freelancer", "freelancing", "client", "clients",
    "project", "projects", "for my", "my", "me", "i", "we", "our",
    "us", "please", "recommend", "any", "good", "best", "cheap",
    "affordable", "expert", "specialist", "the", "in", "for", "a", "an", "to"
  ];

  // فالتو الفاظ کو ایک ایک کر کے جملے سے اڑا دو (صرف پورے الفاظ، آدھے نہیں)
  garbageWords.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    cleanText = cleanText.replace(regex, " ");
  });

  // سپیشل کریکٹرز ہٹا کر صاف الفاظ کی لسٹ بنا لو
  return cleanText
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 1);
}
