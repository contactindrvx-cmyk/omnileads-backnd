export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://my-app-workshop.onhercules.app",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      // 1. تمام پروجیکٹس کی لسٹ حاصل کرنا (Dashboard کے لیے)
      if (request.method === "GET" && url.pathname === "/list") {
        const { results } = await env.DB.prepare("SELECT project_name, repo_name, last_synced FROM ayesha_multi_projects").all();
        return new Response(JSON.stringify(results), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 2. مخصوص پروجیکٹ لوڈ کرنا
      if (request.method === "GET" && url.pathname === "/load") {
        const name = url.searchParams.get("name");
        const result = await env.DB.prepare("SELECT * FROM ayesha_multi_projects WHERE project_name = ?").bind(name).first();
        return new Response(result ? JSON.stringify(result) : "{}", { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 3. پروجیکٹ سیو کرنا
      if (request.method === "POST" && url.pathname === "/save") {
        const { project_name, repo_name, project_state_json } = await request.json();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO ayesha_multi_projects (project_name, repo_name, project_state_json, last_synced) VALUES (?, ?, ?, CURRENT_TIMESTAMP)"
        ).bind(project_name, repo_name, project_state_json).run();
        return new Response("Project Saved", { headers: corsHeaders });
      }
    } catch (err) {
      return new Response(err.message, { status: 500, headers: corsHeaders });
    }
    return new Response("Ayesha Multi-Project Backend Live", { headers: corsHeaders });
  }
};
