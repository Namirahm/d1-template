export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
}

type RefreshRequest = {
  owner: string;
  repo: string;
  slug?: string; // optional override; otherwise taken from manifest.issue.slug or manifest.slug
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c] || c;
  });
}

function validateManifest(manifest: any) {
  if (!manifest || typeof manifest !== "object") throw new Error("Manifest must be an object");
  if (manifest.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

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

  if (!Array.isArray(manifest.pages)) throw new Error("pages must be an array");
  for (const [i, p] of manifest.pages.entries()) {
    if (!p || typeof p !== "object") throw new Error(`pages[${i}] must be an object`);
    if (typeof p.id !== "string" || !p.id.trim()) throw new Error(`pages[${i}].id required`);
    if (typeof p.alt !== "string" || !p.alt.trim()) throw new Error(`pages[${i}].alt required`);
    if (!p.image || typeof p.image !== "object") throw new Error(`pages[${i}].image required`);
    if (typeof p.image.r2Key !== "string" || !p.image.r2Key.trim()) {
      throw new Error(`pages[${i}].image.r2Key required`);
    }
    if (p.pageNumber !== undefined && (typeof p.pageNumber !== "number" || !Number.isFinite(p.pageNumber))) {
      throw new Error(`pages[${i}].pageNumber must be a number if provided`);
    }
  }
}

function pickPage(manifest: any, pageNumber: number): any | null {
  if (!manifest || !Array.isArray(manifest.pages)) return null;

  // Prefer explicit pageNumber fields if present.
  const byNumber = manifest.pages.find((p: any) => typeof p?.pageNumber === "number" && p.pageNumber === pageNumber);
  if (byNumber) return byNumber;

  // Fallback: 1-indexed array position.
  return manifest.pages[pageNumber - 1] ?? null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /api/health
    if (request.method === "GET" && url.pathname === "/api/health") {
      const row = await env.DB.prepare("SELECT 1 AS ok").first();
      return jsonResponse(row);
    }

    // GET /assets/*  (R2 proxy)
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

    // GET /debug-r2?key=...
    if (request.method === "GET" && url.pathname === "/debug-r2") {
      const key = url.searchParams.get("key") || "";
      if (!key) return jsonResponse({ ok: false, error: "Missing key" }, 400);
      const obj = await env.BUCKET.head(key);
      return jsonResponse({ ok: true, key, found: !!obj }, 200);
    }

    // POST /api/github/refresh
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

      const repoRow = await env.DB.prepare(
        `SELECT id, branch, manifest_path FROM repos WHERE github_owner = ? AND github_repo = ?`
      )
        .bind(owner, repo)
        .first<{ id: string; branch: string; manifest_path: string }>();

      if (!repoRow) return jsonResponse({ error: "Repo not registered in D1" }, 404);

      const branch = repoRow.branch || "main";
      const manifestPath = repoRow.manifest_path || "comicyore/manifest.json";
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${manifestPath}`;

      const ghResp = await fetch(rawUrl, { headers: { accept: "application/json" } });
      if (!ghResp.ok) {
        return jsonResponse({ error: "Failed to fetch manifest", status: ghResp.status, url: rawUrl }, 502);
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

      const slug = (body.slug && body.slug.trim()) || manifestSlug;
      const title = manifestTitle;

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

    // GET /read/:owner/:repo?page=1&slug=...
    if (request.method === "GET" && url.pathname.startsWith("/read/")) {
      const parts = url.pathname.split("/").filter(Boolean); // ["read", owner, repo]
      const owner = parts[1];
      const repo = parts[2];
      if (!owner || !repo) return new Response("Bad request", { status: 400 });

      const pageNumber = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const slugParam = (url.searchParams.get("slug") || "").trim();

      const repoRow = await env.DB.prepare(
        `SELECT id FROM repos WHERE github_owner = ? AND github_repo = ?`
      )
        .bind(owner, repo)
        .first<{ id: string }>();

      if (!repoRow) return new Response("Repo not registered", { status: 404 });

      let comicRow: { slug: string; title: string; cached_manifest_json: string } | null = null;

      if (slugParam) {
        comicRow = await env.DB.prepare(
          `SELECT slug, title, cached_manifest_json
           FROM comics
           WHERE repo_id = ? AND slug = ?
           LIMIT 1`
        )
          .bind(repoRow.id, slugParam)
          .first<any>();
      } else {
        // Most recently cached issue for that repo.
        comicRow = await env.DB.prepare(
          `SELECT slug, title, cached_manifest_json
           FROM comics
           WHERE repo_id = ?
           ORDER BY cached_at DESC
           LIMIT 1`
        )
          .bind(repoRow.id)
          .first<any>();
      }

      if (!comicRow?.cached_manifest_json) {
        return new Response("No cached manifest. Run /api/github/refresh.", { status: 404 });
      }

      const manifest = JSON.parse(comicRow.cached_manifest_json);
      const page = pickPage(manifest, pageNumber);
      if (!page) return new Response("Page not found", { status: 404 });

      const r2Key = page?.image?.r2Key;
      if (!r2Key || typeof r2Key !== "string") return new Response("Page missing image.r2Key", { status: 404 });

      const imgUrl = `/assets/${encodeURIComponent(r2Key)}`;
      const title = escapeHtml(
        (typeof manifest?.issue?.title === "string" && manifest.issue.title.trim()) ||
          (typeof manifest?.title === "string" && manifest.title.trim()) ||
          comicRow.title ||
          "Reader"
      );

      const totalPages = Array.isArray(manifest?.pages) ? manifest.pages.length : 0;
      const prev = Math.max(1, pageNumber - 1);
      const next = totalPages ? Math.min(totalPages, pageNumber + 1) : pageNumber + 1;

      const slugQs = `slug=${encodeURIComponent(comicRow.slug)}`;
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 12px; }
    img { width: 100%; height: auto; display: block; }
    .nav { display: flex; justify-content: space-between; align-items: center; margin: 12px 0; }
    a { text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="nav">
      <a href="/read/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?${slugQs}&page=${prev}">Prev</a>
      <div>Page ${pageNumber}${totalPages ? " / " + totalPages : ""}</div>
      <a href="/read/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?${slugQs}&page=${next}">Next</a>
    </div>
    <img src="${imgUrl}" alt="Page ${pageNumber}" />
  </div>
</body>
</html>`;

      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // GET /
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
