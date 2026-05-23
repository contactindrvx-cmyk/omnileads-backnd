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
   SOURCE 2: Hacker News
========================================================================= */
async function scrapeHackerNews(keyword) {
  const leads = [];
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(keyword)}&tags=job&hitsPerPage=10`;
    const res = await fetch(url);
    if (!res.ok) return leads;
    const data = await res.json();
    data?.hits?.forEach(h => {
      leads.push({
        platform: "HackerNews",
        author: h.author || "Company",
        text: (h.title + " " + (h.story_text || "")).substring(0, 400),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`
      });
    });
  } catch (e) {
    console.error("HN:", e.message);
  }
  return leads.slice(0, 8);
}

/* =========================================================================
   SOURCE 3: RemoteOK (Fixed — Tag-based search)
========================================================================= */
async function scrapeRemoteOK(keyword) {
  const leads = [];
  try {
    // پہلا keyword بطور tag استعمال کریں
    const tag = keyword.split(" ")[0];
    const res = await fetch(`https://remoteok.com/api?tag=${encodeURIComponent(tag)}`, {
      headers: { "User-Agent": "OmniLeads/4.1" }
    });
    if (!res.ok) return leads;
    const data = await res.json();
    // پہلی entry metadata ہوتی ہے، اسے skip کریں
    const jobs = Array.isArray(data) ? data.slice(1) : [];
    jobs.slice(0, 6).forEach(job => {
      if (!job.position) return;
      leads.push({
        platform: "RemoteOK", author: job.company || "Unknown",
        text: (job.position + " — " + (job.description || "").replace(/<[^>]*>/gm, "")).substring(0, 400),
        url: job.url || ""
      });
    });
  } catch (e) {
    console.error("RemoteOK:", e.message);
  }
  return leads;
}


/* =========================================================================
   SOURCE 4: Remotive
========================================================================= */
async function scrapeRemotive(keyword) {
  const leads = [];
  try {
    const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(keyword)}&limit=6`;
    const res = await fetch(url);
    if (!res.ok) return leads;
    const data = await res.json();
    data?.jobs?.slice(0, 6).forEach(job => {
      leads.push({
        platform: "Remotive",
        author: job.company_name || "Unknown",
        text: (job.title + " — " + (job.description || "")
          .replace(/<[^>]*>/gm, "")).substring(0, 400),
        url: job.url || ""
      });
    });
  } catch (e) {
    console.error("Remotive:", e.message);
  }
  return leads;
}

/* =========================================================================
   SOURCE 5: WeWorkRemotely (RSS)
========================================================================= */
async function scrapeWeWorkRemotely(keyword) {
  const leads = [];
  try {
    const res = await fetch(`https://weworkremotely.com/remote-jobs.rss`, {
      headers: { "User-Agent": "OmniLeads/4.0" }
    });
    if (!res.ok) return leads;
    const text = await res.text();
    const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const item of items) {
      const titleMatch =
        item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
        item.match(/<title>(.*?)<\/title>/);
      const linkMatch = item.match(/<link>(.*?)<\/link>/);
      if (
        titleMatch &&
        titleMatch[1].toLowerCase().includes(keyword.toLowerCase())
      ) {
        leads.push({
          platform: "WeWorkRemotely",
          author: "WWR",
          text: titleMatch[1],
          url: linkMatch ? linkMatch[1] : "https://weworkremotely.com"
        });
      }
    }
  } catch (e) {
    console.error("WWR:", e.message);
  }
  return leads.slice(0, 5);
}

/* =========================================================================
   SOURCE 6: Dev.to (نیا — فری API)
========================================================================= */
async function scrapeDevTo(keyword) {
  const leads = [];
  try {
    const res = await fetch(
      `https://dev.to/api/articles?tag=hiring&per_page=10`,
      { headers: { "User-Agent": "OmniLeads/4.1" } }
    );
    if (!res.ok) return leads;
    const data = await res.json();
    data
      .filter(a => a.title.toLowerCase().includes(keyword.toLowerCase()) || (a.description || "").toLowerCase().includes(keyword.toLowerCase()))
      .slice(0, 5)
      .forEach(a => leads.push({
        platform: "Dev.to", author: a.user?.name || "Unknown",
        text: (a.title + " " + (a.description || "")).substring(0, 400),
        url: a.url || `https://dev.to${a.path}`
      }));
  } catch (e) {}
  return leads;
    }


/* =========================================================================
   SOURCE 7: Google CSE (UNLOCKED VERSION - For Paid Billing)
   LinkedIn + X + Quora + Indie Hackers + ProductHunt + Facebook
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

  // سب کو ایک ساتھ فائر کرو (Parallel Execution) بجلی کی سپیڈ کے لیے
  const fetchPromises = dorks.map(async (query) => {
    try {
      // 🚨 بریک ہٹا دی گئی ہے: اب num=10 (Maximum) استعمال ہو رہا ہے
      const url = `https://www.googleapis.com/customsearch/v1?key=${env.GOOGLE_CSE_KEY}&cx=${env.GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&num=10`;
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
          platform, 
          author: item.displayLink || "unknown",
          text: (item.title + " " + (item.snippet || "")).substring(0, 400),
          url: item.link
        });
      });
      return localLeads;
    } catch (e) {
      console.error("CSE unlocked dork failed:", e.message);
      return [];
    }
  });

  // سارے رزلٹس کا انتظار کرو اور ایک ہی ارے (Array) میں جوڑ دو
  const allResults = await Promise.all(fetchPromises);
  allResults.forEach(resArray => {
    leads = [...leads, ...resArray];
  });

  return leads;
                 }



/* =========================================================================
   SOURCE 7: Bing Search (Backup)
========================================================================= */
async function scrapeBing(keyword, env) {
  const leads = [];
  const queries = [
    `${keyword} "looking to hire" OR "need a" OR "we are hiring"`,
    `site:linkedin.com "${keyword}" hiring`,
    `site:facebook.com "${keyword}" "looking for"`
  ];
  for (const query of queries) {
    try {
      const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=4`;
      const res = await fetch(url, {
        headers: { "Ocp-Apim-Subscription-Key": env.BING_API_KEY }
      });
      if (!res.ok) continue;
      const data = await res.json();
      data?.webPages?.value?.forEach(item => {
        const platform =
          item.url.includes("linkedin") ? "LinkedIn" :
          item.url.includes("facebook") ? "Facebook" : "Bing Web";
        leads.push({
          platform,
          author: item.displayUrl || "unknown",
          text: (item.name + " " + item.snippet).substring(0, 400),
          url: item.url
        });
      });
    } catch (e) {
      console.error("Bing:", e.message);
    }
  }
  return leads;
}

/* =========================================================================
   AI FILTER: Vertex AI — Simple API Key (No OAuth, No Token)
   آپ کے Cloud Credits یہاں استعمال ہوں گے
========================================================================= */
async function filterWithVertexAI(leads, keyword, env) {
  if (!leads || leads.length === 0) return [];

  const sample = leads.slice(0, 20);
  const prompt = `You are an expert Lead Qualifier for freelancers and agencies.
Analyze these posts and find GENUINE clients looking to HIRE someone for "${keyword}".
Scoring:
- 90-100: Definite hiring post, client is looking to pay someone
- 70-89:  Very likely hiring, clear intent
- 0-69:   Spam, self-promotion, job seekers posting CVs

Return ONLY a valid JSON array. No markdown, no extra text.
Each object must have exactly these keys: "platform", "author", "text", "url", "score"

Posts: ${JSON.stringify(sample)}`;

  // ✅ Simple API Key طریقہ — بالکل آپ کے TARS AI کی طرح
  const project  = env.VERTEX_PROJECT_ID || "tars-ai-chat-ann-assistant";
  const location = env.VERTEX_LOCATION   || "us-central1";
  const model    = "gemini-2.5-flash-lite";
  const key      = env.VERTEX_API_KEY;

  const vertexUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent?key=${key}`;

  try {
    const res = await fetch(vertexUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // کوئی Authorization نہیں
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: prompt }]
        }]
      })
    });

    if (!res.ok) {
      console.error("Vertex Error:", await res.text());
      return sample.map(l => ({ ...l, score: 50 }));
    }

    const data   = await res.json();
    const text   = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

    return parsed
      .filter(l => l.score >= 70)
      .sort((a, b) => b.score - a.score);

  } catch (e) {
    console.error("Vertex filter failed:", e.message);
    return sample.map(l => ({ ...l, score: 50 }));
  }
}

/* =========================================================================
   UTILITY: Keyword Cleaner
========================================================================= */
function getSearchTerms(rawKeyword) {
  const stopWords = new Set([
    'for', 'the', 'in', 'a', 'an', 'looking',
    'need', 'want', 'to', 'hire', 'please', 'help',
    'i', 'me', 'my', 'we', 'our', 'us', 'and', 'or'
    // ✅ 'developer' اور 'designer' نہیں ہیں — یہ ضروری keywords ہیں
  ]);

  return rawKeyword
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w))
    .sort();
                      }
