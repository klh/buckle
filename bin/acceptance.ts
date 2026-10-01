// bin/acceptance.ts — live acceptance gate: proxied e2e against the local
// swarm (:8902, read-only calls only — a small completion + one streaming
// completion; never restarts, never touches :4100 or LiteLLM). Discovers
// the swarm's real model id at startup and builds a temp upstreams config,
// per the design doc's never-trust-the-configured-port rule.
import { resolvePort, startServer } from "../src/server.ts";

const SWARM = "http://127.0.0.1:8902";
const PORT = resolvePort(4101);

interface ModelsResp {
	data: Array<{ id: string }>;
}

const models = (await (await fetch(`${SWARM}/v1/models`)).json()) as ModelsResp;
const modelId = models.data[0]?.id;
if (!modelId) {
	console.error(`acceptance: no models discovered at ${SWARM}/v1/models`);
	process.exit(1);
}
console.log(`acceptance: swarm model discovered: ${modelId}`);

const cfg = `groups:\n  glm-5.3-flash:\n    - url: ${SWARM}\n      dialect: openai\n      model: ${modelId}\n`;
const dir = `/tmp/buckle-acceptance-${Date.now()}`;
await Bun.write(`${dir}/upstreams.yaml`, cfg);
const server = startServer({
	port: PORT,
	upstreamsPath: `${dir}/upstreams.yaml`,
	dbPath: ":memory:",
});
const base = `http://127.0.0.1:${server.port}`;

// 1) non-streaming completion through the router
const t0 = performance.now();
const res = await fetch(`${base}/v1/chat/completions`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		model: "glm-5.3-flash",
		messages: [{ role: "user", content: "Reply with exactly: acceptance-ok" }],
		max_tokens: 16,
		stream: false,
	}),
});
const body = (await res.json()) as {
	choices?: Array<{ message?: { content?: string } }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
	error?: { message?: string };
};
if (!res.ok || !body.choices?.[0]?.message?.content) {
	console.error(
		`acceptance FAIL (non-streaming): ${String(res.status)} ${JSON.stringify(body).slice(0, 300)}`,
	);
	process.exit(1);
}
console.log(
	`acceptance: non-streaming OK (${String(Math.round(performance.now() - t0))}ms, usage in=${String(body.usage?.prompt_tokens)} out=${String(body.usage?.completion_tokens)})`,
);

// 2) streaming completion through the router (byte-plausible SSE)
const sres = await fetch(`${base}/v1/chat/completions`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		model: "glm-5.3-flash",
		messages: [{ role: "user", content: "Count from 1 to 5." }],
		max_tokens: 32,
		stream: true,
	}),
});
if (sres.status !== 200 || sres.body === null) {
	console.error(`acceptance FAIL (streaming): ${String(sres.status)}`);
	process.exit(1);
}
const text = await new Response(sres.body).text();
const chunks = (text.match(/^data: /gm) ?? []).length;
if (chunks < 2 || !text.includes("[DONE]") || !text.includes('"content"')) {
	console.error(
		`acceptance FAIL (streaming): chunks=${String(chunks)} done=${String(text.includes("[DONE]"))}`,
	);
	process.exit(1);
}
console.log(
	`acceptance: streaming OK (${String(chunks)} SSE chunks, [DONE] sentinel, content deltas)`,
);

// 3) servicemon surface
const sres2 = await fetch(`${base}/status`);
const status = (await sres2.json()) as {
	service: string;
	requests: { total: number };
};
const mres = await fetch(`${base}/metrics`);
const metrics = await mres.text();
console.log(
	`acceptance: servicemon OK (service=${status.service} requests=${String(status.requests.total)}, tokens_total=${String(metrics.includes("tokens_total"))})`,
);
server.stop(true);
console.log("acceptance: PASS");
