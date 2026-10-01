// test/mock.ts — mock upstream server for router/handler tests: records
// calls, replays a scripted handler, random loopback port.
export interface MockCall {
	path: string;
	body: Record<string, unknown> | null;
	auth: string | null;
	n: number;
}

export interface MockUpstream {
	url: string;
	port: number;
	calls: MockCall[];
	close(): void;
}

type Handler = (
	req: Request,
	body: Record<string, unknown> | null,
	n: number,
) => Response | Promise<Response>;

export async function startMockUpstream(
	handler: Handler,
	opts?: { hostname?: string },
): Promise<MockUpstream> {
	const calls: MockCall[] = [];
	const server = Bun.serve({
		hostname: opts?.hostname ?? "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json().catch(() => null)) as Record<
				string,
				unknown
			> | null;
			calls.push({
				path: new URL(req.url).pathname,
				body,
				auth: req.headers.get("authorization"),
				n: calls.length + 1,
			});
			return handler(req, body, calls.length);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		port: server.port ?? 0,
		calls,
		close: () => server.stop(true),
	};
}
