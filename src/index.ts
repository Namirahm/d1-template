export interface Env {
  DB: D1Database;
}

type RefreshRequest = {
  owner: string;
  repo: string;
  slug?: string; // optional override; otherwise taken from manifest.slug
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function badRequest(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

function assertString(x: unknown, name: string): string {
  if (typeof x !== "string" || x.trim() === "") throw new Error(`Invalid ${name}`);
  return x.trim();
}

function validateManifest(manifest: any) {
  if (!manifest || typeof manifest !== "object") throw new Error("Manifest must be an object");
  if (manifest.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (typeof manifest.title !== "string" || !manifest.title.trim()) throw new Error("title required");
  if (typeof manifest.slug !== "string" || !manifest.slug.trim()) throw new Error("slug required");

  if (!Array.isArray(manifest.pages)) throw new Error("pages must be an array");
  for (const [i, p] of manifest.pages.entries()) {
    if (!p || typeof p !== "object") throw new Error(`pages[${i}] must be an object`);
    if (typeof p.id !== "string" || !p.id.trim()) throw new Error(`pages[${i}].id required`);
    if (typeof p.alt !== "string" || !p.alt.trim()) throw new Error(`pages[${i}].alt required`);
    if (!p.image || typeof p.image !== "object") throw new Error(`pages[${i}].image required`);
    if (typeof p.image.r2Key !== "string" || !p.image.r2Key.trim())
      throw new Error(`pages[${i}].image.r2Key required`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/github/refresh") {
      let body: RefreshRequest;
      try {
        body = (await request.json()) as RefreshRequest;
      } catch {
        return badRequest("Body must be JSON");
      }

      let owner: string, repo: string;
      try {
        owner = assertString(body.owner, "owner");
        repo = assertString(body.repo, "repo");
      } catch (e: any) {
        return badRequest(e.message);
      }

      // Look up repo configuration
      const repoRow = await env.DB.prepare(
        `SELECT id, branch, manifest_path FROM repos WHERE github_owner = ? AND github_repo = ?`
      )
        .bind(owner, repo)
        .first<{ id: string; branch: string; manifest_path: string }>();

      if (!repoRow) return jsonResponse({ error: "Repo not registered in D1" }, 404);

      const branch = repoRow.branch || "main";
      const manifestPath = repoRow.manifest_path || "comicyore/manifest.json";

      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${manifestPath}`;

      // Fetch manifest
      const ghResp = await fetch(rawUrl, {
        headers: {
          "accept": "application/json",
          // No auth in this MVP; repo must be public
        },
      });

      if (!ghResp.ok) {
        return jsonResponse(
          { error: "Failed to fetch manifest", status: ghResp.status, url: rawUrl },
          502
        );
      }

      let manifest: any;
      try {
        manifest = await ghResp.json();
      } catch {
        return jsonResponse({ error: "Manifest is not valid JSON", url: rawUrl }, 502);
      }

      try {
        validateManifest(manifest);
      } catch (e: any) {
        return jsonResponse({ error: `Manifest validation failed: ${e.message}` }, 422);
      }

      const slug = (body.slug && body.slug.trim()) || manifest.slug.trim();
      const title = manifest.title.trim();

      // Upsert cached manifest
      // D1 does not support a native UPSERT with RETURNING everywhere; do insert-then-update fallback.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO comics (id, repo_id, slug, title, status, cached_manifest_json, cached_at)
         VALUES (?, ?, ?, ?, 'draft', ?, datetime('now'))`
      )
        .bind(`comic_${repoRow.id}_${slug}`, repoRow.id, slug, title, JSON.stringify(manifest))
        .run();

      await env.DB.prepare(
        `UPDATE comics
         SET title = ?, cached_manifest_json = ?, cached_at = datetime('now'), updated_at = datetime('now')
         WHERE repo_id = ? AND slug = ?`
      )
        .bind(title, JSON.stringify(manifest), repoRow.id, slug)
        .run();

      return jsonResponse({
        ok: true,
        owner,
        repo,
        branch,
        manifestPath,
        rawUrl,
        cached: { slug, title },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      const row = await env.DB.prepare("SELECT 1 AS ok").first();
      return jsonResponse(row);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;