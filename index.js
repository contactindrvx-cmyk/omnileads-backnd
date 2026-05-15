export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    if (request.method === "POST" && url.pathname === "/ai-generate") {
      try {
        const { prompt } = await request.json();
        
        // Gemini 3.1 Pro Latest (No strict schema to avoid 500 crashes)
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-latest:generateContent?key=${env.GEMINI_API_KEY}`;

        const aiResponse = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json"
            }
          })
        });

        if (!aiResponse.ok) {
          const errData = await aiResponse.json();
          throw new Error(errData.error?.message || "Google API Error");
        }

        const data = await aiResponse.json();
        return new Response(JSON.stringify(data), { 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }
    
    return new Response("Mistri Backend 3.1 Pro Online", { headers: corsHeaders });
  }
};
