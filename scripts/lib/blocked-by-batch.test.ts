// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	GH_GRAPHQL_NO_REPO,
	GH_NOT_FOUND,
	LINKS_GRAPHQL_FAKE,
	RECORDED_SHAPES,
} from "./gh-fake";
import { type GhStubServer, serveGhStub, stubGhScript } from "./gh-stub";

const { blockedByMany } = require("./blocked-by-batch.js");

interface Row {
	number: number;
	state: "open" | "closed";
}
interface Fixture {
	deps?: Record<number, Row[]>;
	nullInBatch?: number[];
	failRestOnce?: number[];
	failBatch?: "always" | "once";
	batchAnswers?: "empty" | "noRepo";
}

const HANDLER = String.raw`const fs = require("node:fs");
const path = require("node:path");
const fx = JSON.parse(fs.readFileSync(path.join(env.GH_STUB_DIR, "fixture.json"), "utf8"));
fs.appendFileSync(path.join(env.GH_STUB_DIR, "calls"), argv[1] + "\n");
const bump = (k) => {
  const file = path.join(env.GH_STUB_DIR, "seen.json");
  const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  s[k] = (s[k] || 0) + 1;
  fs.writeFileSync(file, JSON.stringify(s));
  return s[k];
};
${LINKS_GRAPHQL_FAKE}
${RECORDED_SHAPES}
const fail = () => serveHandlerAnswer(${JSON.stringify(GH_NOT_FOUND)});
if (argv[1] === "graphql") {
  if (fx.failBatch === "always") return fail();
  if (fx.failBatch === "once" && bump("graphql") === 1) return fail();
  if (fx.batchAnswers === "empty") return;
  if (fx.batchAnswers === "noRepo") return serveHandlerAnswer(${JSON.stringify(GH_GRAPHQL_NO_REPO)});
  return serveHandlerAnswer(answerLinks(argv, (_repo, n) =>
    (fx.nullInBatch || []).includes(n) ? null : { blockedBy: (fx.deps || {})[n] || [] }));
}
const n = Number(argv[1].match(/issues\/(\d+)\/dependencies\/blocked_by/)[1]);
if ((fx.failRestOnce || []).includes(n) && bump("rest" + n) === 1) return fail();
out(asRecorded("blockedByPage", [((fx.deps || {})[n] || []).map((e) => ({
  number: e.number, state: e.state, title: "issue " + e.number,
}))]) + "\n");
`;

let server: GhStubServer;
beforeAll(async () => {
	server = await serveGhStub(HANDLER);
});
afterAll(() => server.close());

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "blocked-by-batch-"));
	vi.stubEnv("WFC_GH", stubGhScript(dir, server.script).gh);
	vi.stubEnv("GH_STUB_DIR", dir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

async function read(numbers: number[], fx: Fixture) {
	fs.writeFileSync(path.join(dir, "fixture.json"), JSON.stringify(fx));
	const reads = await blockedByMany(
		numbers.map((number) => ({ number })),
		{ repo: "o/r", home: "o/r" },
	);
	const callsFile = path.join(dir, "calls");
	return {
		of: (n: number) =>
			reads.find((r: { issue: { number: number } }) => r.issue.number === n)
				.read,
		calls: fs.existsSync(callsFile)
			? fs.readFileSync(callsFile, "utf8").trim().split("\n")
			: [],
	};
}
const numbersOf = (answer: { edges: { number: number }[] }) =>
	answer.edges.map((e) => e.number);
const REST = (n: number) => `repos/o/r/issues/${n}/dependencies/blocked_by`;

describe("blockedByMany (#2685)", () => {
	it("retries an issue's REST read once where the batch answered it null, and keeps its blockers", async () => {
		const r = await read([1, 2], {
			deps: { 2: [{ number: 9, state: "open" }] },
			nullInBatch: [2],
			failRestOnce: [2],
		});
		expect(r.of(1)).toEqual({ ok: true, edges: [] });
		expect(r.of(2)).toMatchObject({ ok: true });
		expect(numbersOf(r.of(2))).toEqual([9]);
		expect(r.calls).toEqual(["graphql", REST(2), REST(2)]);
	});

	it("reads the full blocker list of an issue past the batch's inner page, and only that issue's", async () => {
		const many = Array.from({ length: 26 }, (_, k) => ({
			number: 100 + k,
			state: k === 25 ? ("open" as const) : ("closed" as const),
		}));
		const r = await read([1, 2], { deps: { 1: many } });
		expect(r.calls).toEqual(["graphql", REST(1)]);
		expect(numbersOf(r.of(1))).toContain(125);
		expect(r.of(1).edges).toHaveLength(26);
		expect(r.of(2)).toEqual({ ok: true, edges: [] });
	});

	it("reads every issue of a batch failing twice as unknown, keeping gh's error, with no REST read", async () => {
		const r = await read([1, 2], { failBatch: "always" });
		for (const n of [1, 2])
			expect(r.of(n)).toMatchObject({
				ok: false,
				error: expect.stringContaining(GH_NOT_FOUND.stderr.trim()),
			});
		expect(r.calls).toEqual(["graphql", "graphql"]);
	});

	it("retries a failed batch once and keeps its issues on a success", async () => {
		const r = await read([1, 2], {
			deps: { 2: [{ number: 1, state: "open" }] },
			failBatch: "once",
		});
		expect(r.of(1)).toEqual({ ok: true, edges: [] });
		expect(numbersOf(r.of(2))).toEqual([1]);
		expect(r.calls).toEqual(["graphql", "graphql"]);
	});

	for (const answer of ["empty", "noRepo"] as const)
		it(`reads a batch answering ${answer} as readiness unknown, never as no blockers`, async () => {
			const r = await read([1], {
				deps: { 1: [{ number: 9, state: "open" }] },
				batchAnswers: answer,
			});
			expect(r.of(1)).toMatchObject({ ok: false });
			expect(r.calls).toEqual(["graphql", "graphql"]);
		});
});
