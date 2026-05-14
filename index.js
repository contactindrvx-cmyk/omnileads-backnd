export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // یہاں ہم نے آپ کا اصلی فرنٹ اینڈ لنک ڈال دیا ہے
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://my-workshopapppp.pages.dev",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Preflight (OPTIONS) ریکویسٹ کو ہینڈل کرنا
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // AI Generation End-point
    if (request.method === "POST" && url.pathname === "/ai-generate") {
      try {
        const { prompt } = await request.json();
        
        // Gemini 3.1 Pro Latest (آپ کی ریکویسٹ کے مطابق)
        const targetModel = "gemini-3.1-pro-latest";
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${env.GEMINI_API_KEY}`;

        const aiResponse = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }]
          })
        });

        const data = await aiResponse.json();
        return new Response(JSON.stringify(data), { 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { 
          status: 500, 
          headers: corsHeaders 
        });
      }
    }

    return new Response("Mistri Backend Online", { headers: corsHeaders });
  }
};
