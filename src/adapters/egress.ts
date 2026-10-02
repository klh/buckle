// src/adapters/egress.ts — outbound URL law (review #13 §1.3 SSRF /
// credential hygiene). Token endpoints receive client secrets / signed
// JWTs, so they are https + allowlisted host only; upstream base URLs are
// https, or plain http to an explicit loopback literal (the local swarm),
// or plain http to a host the operator lists in BUCKLE_HTTP_UPSTREAM_HOSTS.

/** Credential-bearing token fetches never hang an attempt. */
export const TOKEN_FETCH_TIMEOUT_MS = 10_000;

/** Well-known Entra authority hosts (public, US gov, China clouds). */
export const AZURE_TOKEN_HOSTS = [
	"login.microsoftonline.com",
	"login.microsoftonline.us",
	"login.chinacloudapi.cn",
	"login.partner.microsoftonline.cn",
] as const;

/** Google oauth2 token endpoint host. */
export const GCP_TOKEN_HOSTS = ["oauth2.googleapis.com"] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(hostname: string): boolean {
	return LOOPBACK_HOSTS.has(hostname) || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

const envList = (name: string): string[] =>
	(process.env[name] ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0);

/** token_host → its origin URL, or throw. `allowed` = the family's
 *  well-known token hosts; BUCKLE_TOKEN_HOSTS adds operator hosts (https
 *  only); BUCKLE_TOKEN_HOST_LOOPBACK=on admits loopback mocks (tests/dev,
 *  http allowed there — nothing leaves the machine). */
export function tokenOrigin(
	tokenHost: string | undefined,
	defaultHost: string,
	allowed: readonly string[],
): string {
	const raw = tokenHost ?? defaultHost;
	let u: URL;
	try {
		u = new URL(raw.includes("://") ? raw : `https://${raw}`);
	} catch {
		throw new Error(`token_host "${raw}" is not a valid host`);
	}
	if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
		throw new Error(
			`token_host "${raw}" must be a bare host (no path/userinfo)`,
		);
	const host = u.hostname.toLowerCase();
	if (isLoopbackHost(host) && process.env.BUCKLE_TOKEN_HOST_LOOPBACK === "on") {
		if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
	}
	if (u.protocol !== "https:")
		throw new Error(`token_host "${raw}" refused: https required`);
	const ok = [...allowed, ...envList("BUCKLE_TOKEN_HOSTS")].some(
		(a) => a.toLowerCase() === host,
	);
	if (!ok)
		throw new Error(
			`token_host "${host}" refused: not in the allowlist (${allowed.join(", ")}; extend via BUCKLE_TOKEN_HOSTS)`,
		);
	return u.origin;
}

/** Upstream base URL law, enforced at pool load (startup-fatal). */
export function validateUpstreamUrl(url: string): void {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new Error(`url "${url}" is not a valid URL`);
	}
	if (u.username || u.password)
		throw new Error(
			`url "${u.host}" must not carry credentials (use api_key_env)`,
		);
	if (u.protocol === "https:") return;
	if (u.protocol !== "http:")
		throw new Error(
			`url scheme ${u.protocol} refused (https or loopback http)`,
		);
	const host = u.hostname.toLowerCase();
	if (isLoopbackHost(host)) return;
	if (envList("BUCKLE_HTTP_UPSTREAM_HOSTS").includes(host)) return;
	throw new Error(
		`url http://${host} refused: plain http only to loopback or hosts listed in BUCKLE_HTTP_UPSTREAM_HOSTS`,
	);
}

/** Startup check for one deployment: base URL + any family token_host
 *  (fail closed at load, not at the first credential-bearing request). */
export function validateDeploymentEgress(
	family: string,
	dep: { url: string; adapter_config?: Record<string, unknown> },
): void {
	validateUpstreamUrl(dep.url);
	const cfg = dep.adapter_config ?? {};
	if (family === "azure-openai") {
		const entra = cfg.entra as { token_host?: unknown } | undefined;
		if (entra && typeof entra === "object" && entra.token_host !== undefined)
			tokenOrigin(
				String(entra.token_host),
				AZURE_TOKEN_HOSTS[0],
				AZURE_TOKEN_HOSTS,
			);
	} else if (family === "vertex" && cfg.token_host !== undefined) {
		tokenOrigin(String(cfg.token_host), GCP_TOKEN_HOSTS[0], GCP_TOKEN_HOSTS);
	}
}
