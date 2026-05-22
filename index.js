/**
 * OmniLeads Master Backend Worker
 * Environment: Cloudflare Workers
 * Database: Cloudflare D1 (env.DB)
 * AI: Google Cloud Vertex AI (Gemini 2.5 Flash Lite)
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Only POST requests allowed" }), { status: 405 });
    }

    try {
      const { keyword, userId } = await request.json();

      if (!keyword) {
        return new Response(JSON.stringify({ error: "Keyword is required" }), { status: 400 });
      }

      const cleanTerms = getSearchTerms(keyword);
      const masterKeyword = cleanTerms.join(" ");

      // 1. ڈی ون (D1) ڈیٹا بیس میں چیک کریں
      let dbQuery = "SELECT * FROM leads WHERE ";
      let conditions = [];
      let params = [];

      cleanTerms.forEach((term) => {
        conditions.push(`keyword LIKE ?`);
        params.push(`%${term}%`);
      });

      dbQuery += conditions.join(" AND ");
      dbQuery += " ORDER BY created_at DESC LIMIT 50";

      const { results: cachedLeads } = await env.DB.prepare(dbQuery).bind(...params).all();

      if (cachedLeads && cachedLeads.length > 0) {
        return new Response(JSON.stringify({ 
          source: "database", 
          message: "Fetched from D1 Cache",
          leads: cachedLeads 
        }), { headers: { "Content-Type": "application/json" } });
      }

      // 2. انٹرنیٹ سے نیا مال اٹھائیں (Scraping)
      const scrapedData = await scrapeMultiPlatforms(masterKeyword);

      // 3. Vertex AI (Gemini) سے فلٹر کروائیں
      const aiFilteredLeads = await filterLeadsWithVertexAI(scrapedData, masterKeyword, env);

      // 4. ڈیٹا بیس میں محفوظ کریں
      if (aiFilteredLeads.length > 0) {
        const stmt = env.DB.prepare(`
          INSERT OR IGNORE INTO leads (id, keyword, platform, author_name, post_text, source_url, match_score) 
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const batchStmts = aiFilteredLeads.map(lead => 
          stmt.bind(crypto.randomUUID(), masterKeyword, lead.platform, lead.author, lead.text, lead.url, lead.score)
        );

        await env.DB.batch(batchStmts);
      }

      return new Response(JSON.stringify({ 
        source: "live_scraping", 
        message: "Scraped new leads and saved to D1 via Vertex AI",
        leads: aiFilteredLeads 
      }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    try {
      const deleteQuery = `DELETE FROM leads WHERE created_at < datetime('now', '-7 days');`;
      await env.DB.prepare(deleteQuery).run();
      console.log("Old leads cleaned up successfully.");
    } catch (error) {
      console.error("Cron Job Error:", error);
    }
  }
};

/* =========================================================================
   HELPER FUNCTIONS (مددگار فنکشنز)
========================================================================= */

function getSearchTerms(rawKeyword) {
  const stopWords = ['for', 'the', 'in', 'a', 'an', 'looking', 'need', 'want', 'developer', 'expert', 'to', 'hire'];
  let words = rawKeyword.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  return words.filter(w => !stopWords.includes(w) && w.length > 0).sort();
}

async function scrapeMultiPlatforms(keyword) {
  let allLeads = [];
  try {
    const redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}+flair:hiring OR flair:job&sort=new&t=week`;
    const redditRes = await fetch(redditUrl, { headers: { "User-Agent": "OmniLeads Bot 1.0" }});
    const redditData = await redditRes.json();
    
    if (redditData.data && redditData.data.children) {
      redditData.data.children.forEach(post => {
        allLeads.push({
          platform: "Reddit",
          author: post.data.author,
          text: post.data.title + "\n" + post.data.selftext,
          url: "https://reddit.com" + post.data.permalink
        });
      });
    }
  } catch (e) { console.error("Reddit scrape failed", e); }
  return allLeads;
}

// 🚀 نیا Vertex AI (Gemini) فلٹریشن فنکشن
async function filterLeadsWithVertexAI(leads, keyword, env) {
  if (!leads || leads.length === 0) return [];

  const leadsToFilter = leads.slice(0, 10);
  const prompt = `
  You are an expert Lead Qualifier. Analyze these posts and find GENUINE clients looking to hire a "${keyword}".
  Give a match_score from 0 to 100. If spam or promotion, give 0.
  
  You MUST return ONLY a JSON array of objects with exactly these keys: "platform", "author", "text", "url", "score".
  
  Posts to analyze: ${JSON.stringify(leadsToFilter)}
  `;

  // آپ کے دئیے گئے کوڈ کے مطابق Vertex AI کی سیٹنگز
  const project = "tars-ai-chat-ann-assistant";
  const location = "us-central1";
  const vertexKey = env.VERTEX_API_KEY; 
  const model = "gemini-2.5-flash-lite"; // تیز اور سستا ترین ماڈل

  const vertexUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent?key=${vertexKey}`;

  try {
    const aiRes = await fetch(vertexUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json" // 👈 یہ جمنائی کو مجبور کرے گا کہ صرف JSON دے
        }
      })
    });

    if (!aiRes.ok) {
      console.error("Vertex API Error:", await aiRes.text());
      throw new Error("Vertex API returned an error.");
    }

    const aiData = await aiRes.json();
    const resultText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    
    const parsedLeads = JSON.parse(resultText);
    return parsedLeads.filter(lead => lead.score >= 70); // صرف 70 سے اوپر سکور والی لیڈز پاس ہوں گی

  } catch (error) {
    console.error("Vertex AI filtering failed:", error);
    // اگر کسی وجہ سے API فیل ہو جائے، تو سسٹم کریش نہیں ہوگا، ڈیفالٹ سکور دے کر آگے بڑھ جائے گا
    return leadsToFilter.map(l => ({ ...l, score: 50 })); 
  }
          }
        
