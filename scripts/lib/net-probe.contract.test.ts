// @vitest-environment node
/*
 * Holds lib/net-probe-fake.ts, the probe stand-in the refill loop's run suites
 * name at WFC_NET_PROBE, to lib/net-probe.js's real child (#4826). The real
 * `main` runs offline through its seams: a lookup that fails as an offline
 * resolver does, and a loopback port nothing listens on.
 *
 * The lookup error's code is the test's choice, taken from the stand-in's
 * line.
 *
 * Residual: the connect-timeout line has no offline case, as no loopback peer
 * reliably leaves a SYN unanswered; and the child's shell is not run here.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { main, probeNetwork } from "./net-probe.js";
import { NET_PROBE_OFFLINE_LINE, writeNetProbeFake } from "./net-probe-fake";

type Lookup = NonNullable<NonNullable<Parameters<typeof main>[0]>["lookup"]>;

let dir = "";

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "net-probe-contract-"));
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const loopback: Lookup = (_host, cb) => cb(null, "127.0.0.1");

async function onPort<T>(
	closed: boolean,
	body: (port: number) => Promise<T>,
): Promise<T> {
	const server = net.createServer((s) => s.destroy());
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as net.AddressInfo;
	if (closed) await new Promise((r) => server.close(r));
	try {
		return await body(port);
	} finally {
		if (!closed) await new Promise((r) => server.close(r));
	}
}

it("prints the stand-in's offline line when the host does not resolve", async () => {
	const code = NET_PROBE_OFFLINE_LINE.split(": ").at(-1);
	const offline: Lookup = (_host, cb) =>
		cb(Object.assign(new Error(`getaddrinfo ${code}`), { code }), "");
	const real = await main({ lookup: offline });
	expect(real).toBe(NET_PROBE_OFFLINE_LINE);

	const fake = path.join(dir, "probe");
	const marker = path.join(dir, "offline");
	writeNetProbeFake(fake, marker);
	fs.writeFileSync(marker, "");
	expect(probeNetwork({ ...process.env, WFC_NET_PROBE: fake })).toBe(real);
	fs.rmSync(marker);
	expect(probeNetwork({ ...process.env, WFC_NET_PROBE: fake })).toBeNull();
});

it("reads a listening port as reachable", async () => {
	await onPort(false, async (port) => {
		expect(await main({ lookup: loopback, port })).toBeNull();
	});
});

it("prints the refused line when nothing listens on the port", async () => {
	await onPort(true, async (port) => {
		expect(await main({ lookup: loopback, port })).toBe(
			`api.anthropic.com:${port} refused: connect ECONNREFUSED 127.0.0.1:${port}`,
		);
	});
});

it("prints the no-answer line when the lookup never answers", async () => {
	/* The seam's timeout, not the shipped 3 s: any short value, as only the
	 * line is under test (§X9). */
	const silent: Lookup = () => undefined;
	expect(await main({ lookup: silent, timeoutMs: 10 })).toBe(
		"api.anthropic.com gave no answer in 10 ms",
	);
});
