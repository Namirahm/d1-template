export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
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

  // Accept either:
  // (A) new structure: manifest.issue.title + manifest.issue.slug
  // (B) legacy structure: manifest.title + manifest.slug
  const issueTitle = manifest?.issue?.title;
  const issueSlug = manifest?.issue?.slug;

  const legacyTitle = manifest?.title;
  const legacySlug = manifest?.slug;

  const title =
    (typeof issueTitle === "string" && issueTitle.trim()) ||
    (typeof legacyTitle === "string" && legacyTitle.trim());

  const slug =
    (typeof issueSlug === "string" && issueSlug.trim()) ||
    (typeof legacySlug === "string" && legacySlug.trim());

  if (!title) throw new Error("issue.title (or top-level title) required");
  if (!slug) throw new Error("issue.slug (or top-level slug) required");

  // Validate pages
  if (!Array.isArray(manifest.pages)) throw new Error("pages must be an array");
  for (const [i, p] of manifest.pages.entries()) {
    if (!p || typeof p !== "object") throw new Error(`pages[${i}] must be an object`);
    if (typeof p.id !== "string" || !p.id.trim()) throw new Error(`pages[${i}].id required`);
    if (typeof p.alt !== "string" || !p.alt.trim()) throw new Error(`pages[${i}].alt required`);
    if (!p.image || typeof p.image !== "object") throw new Error(`pages[${i}].image required`);
    if (typeof p.image.r2Key !== "string" || !p.image.r2Key.trim())
      throw new Error(`pages[${i}].image.r2Key required`);

    if (p.pageNumber !== undefined && (typeof p.pageNumber !== "number" || !Number.isFinite(p.pageNumber)))
      throw new Error(`pages[${i}].pageNumber must be a number if provided`);
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

      const manifestTitle =
        (typeof manifest?.issue?.title === "string" && manifest.issue.title.trim()) ||
        (typeof manifest?.title === "string" && manifest.title.trim()) ||
      "";

      const manifestSlug =
        (typeof manifest?.issue?.slug === "string" && manifest.issue.slug.trim()) ||
        (typeof manifest?.slug === "string" && manifest.slug.trim()) ||
      "";

// Allow override via request body.slug, otherwise use manifest-derived slug
      const slug = (body.slug && body.slug.trim()) || manifestSlug;
      const title = manifestTitle;


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

    // GET /assets/:r2Key  (R2 proxy)
    if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
  const key = decodeURIComponent(url.pathname.slice("/assets/".length));
  if (!key) return new Response("Missing R2 key", { status: 400 });

  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");

  return new Response(obj.body, { headers });
    }


    if (request.method === "GET" && url.pathname === "/api/health") {
      const row = await env.DB.prepare("SELECT 1 AS ok").first();
      return jsonResponse(row);
    }

    if (request.method === "GET" && url.pathname === "/debug-r2") {
      const key = "publishers/kraken/chance-magic/issue-001/pages/p001.jpg";
      const obj = await env.BUCKET.get(key);
      return new Response(obj ? "FOUND" : "NOT FOUND", { status: 200 });
    }


	if (request.method === "GET" && url.pathname === "/") {
  		return new Response("ok", {headers: { "content-type": "text/plain" },
	});
}

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;