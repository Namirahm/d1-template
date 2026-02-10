import { renderHtml } from "./renderHtml";

export default {
	async fetch(request, env) {
		const stmt = await env.DB.prepare("SELECT 1 AS ok").first();
		const { results } = await stmt.all();

		return new Response(renderHtml(JSON.stringify(results, null, 2)), {
			headers: {
				"content-type": "text/html",
			},
		});
	},
} satisfies ExportedHandler<Env>;
