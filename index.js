export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // آپ کا نیا Pages URL یہاں سیٹ کر دیا ہے
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://my-workshopapppp.pages.dev",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      // 1. تمام پروجیکٹس کی لسٹ (Dashboard کے لیے)
      if (request.method === "GET" && url.pathname === "/list") {
        const { results } = await env.DB.prepare("SELECT project_name, repo_name, last_synced FROM ayesha_multi_projects ORDER BY last_synced DESC").all();
        return new Response(JSON.stringify(results), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 2. مخصوص پروجیکٹ لوڈ کرنا
      if (request.method === "GET" && url.pathname === "/load") {
        const name = url.searchParams.get("name");
        const result = await env.DB.prepare("SELECT * FROM ayesha_multi_projects WHERE project_name = ?").bind(name).first();
        return new Response(result ? JSON.stringify(result) : "{}", { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 3. پروجیکٹ سیو کرنا یا اپڈیٹ کرنا
      if (request.method === "POST" && url.pathname === "/save") {
        const { project_name, repo_name, project_state_json } = await request.json();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO ayesha_multi_projects (project_name, repo_name, project_state_json, last_synced) VALUES (?, ?, ?, CURRENT_TIMESTAMP)"
        ).bind(project_name, repo_name, project_state_json).run();
        return new Response(JSON.stringify({ success: true, message: "Project Saved" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 4. پروجیکٹ ڈیلیٹ کرنا
      if (request.method === "DELETE" && url.pathname === "/delete") {
        const name = url.searchParams.get("name");
        await env.DB.prepare("DELETE FROM ayesha_multi_projects WHERE project_name = ?").bind(name).run();
        return new Response(JSON.stringify({ success: true, message: "Project Deleted" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    
    return new Response("Mistri AI Backend Live", { headers: corsHeaders });
  }
};
