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

const mod = require("./test-inflight.js");

let root: string;
let sharedDir: string;
let shared: string;

const FOREIGN = [{ module: "/other/live.test.ts", stage: "loading" }];

const recordAt = (r: string) =>
	path.join(r, ".claude", "tmp", "markers", ".test-inflight.json");

beforeAll(() => {
	sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-inflight-live-"));
	shared = path.join(sharedDir, "live.json");
	fs.writeFileSync(shared, `${JSON.stringify(FOREIGN)}\n`);
});

beforeEach(() => {
	vi.stubEnv(mod.INFLIGHT_ENV, shared);
	vi.stubEnv(mod.INFLIGHT_ENV, undefined);
	root = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-inflight-"));
	mod.begin(root);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
	fs.rmSync(sharedDir, { recursive: true, force: true });
});

describe("what a reader outside the process sees", () => {
	it("names a module that entered and never left", () => {
		mod.enter(root, "/repo/a.test.ts", "loading");

		expect(mod.read(root)).toEqual([
			{ module: "/repo/a.test.ts", stage: "loading" },
		]);
	});

	it("drops a module that finished", () => {
		mod.enter(root, "/repo/a.test.ts", "loading");
		mod.leave(root, "/repo/a.test.ts");

		expect(mod.read(root)).toEqual([]);
	});

	it("holds the several a worker pool has open at once", () => {
		mod.enter(root, "/repo/a.test.ts", "loading");
		mod.enter(root, "/repo/b.test.ts", "loading");
		mod.leave(root, "/repo/a.test.ts");

		expect(mod.read(root)).toEqual([
			{ module: "/repo/b.test.ts", stage: "loading" },
		]);
	});

	it("keeps a collected module open, at its new stage", () => {
		mod.enter(root, "/repo/a.test.ts", "loading");
		mod.enter(root, "/repo/a.test.ts", "running its tests");

		expect(mod.read(root)).toEqual([
			{ module: "/repo/a.test.ts", stage: "running its tests" },
		]);
	});

	it("starts each run empty, so no reader meets the last run's leftovers", () => {
		mod.enter(root, "/repo/stale.test.ts", "loading");
		mod.begin(root);

		expect(mod.read(root)).toEqual([]);
	});

	it("lists the modules that finished, and starts each run with none", () => {
		mod.enter(root, "/repo/a.test.ts", "loading");
		mod.enter(root, "/repo/b.test.ts", "loading");
		mod.leave(root, "/repo/a.test.ts");

		expect(mod.readRecord(recordAt(root))).toEqual({
			open: [{ module: "/repo/b.test.ts", stage: "loading" }],
			finished: ["/repo/a.test.ts"],
			scheduled: null,
		});

		mod.begin(root);

		expect(mod.readRecord(recordAt(root)).finished).toEqual([]);
	});

	it("moves the record's mtime on a beat, and leaves its content alone", () => {
		mod.enter(root, "/repo/a.test.ts", "loading");
		const file = recordAt(root);
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(file, past, past);
		const before = fs.readFileSync(file, "utf8");

		mod.beat(root);

		expect(mod.lastBeat(file)).toBeGreaterThan(past.getTime() + 30_000);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});

	it("leaves no file behind once the run ends", () => {
		mod.enter(root, "/repo/a.test.ts", "loading");
		mod.clear(root);

		expect(fs.existsSync(recordAt(root))).toBe(false);
		expect(mod.read(root)).toEqual([]);
	});
});

describe("which record a case actually touches", () => {
	it("writes under its own root while the wrapper's record is named", () => {
		mod.enter(root, "/repo/a.test.ts", "loading");

		expect(JSON.parse(fs.readFileSync(recordAt(root), "utf8")).open).toEqual([
			{ module: "/repo/a.test.ts", stage: "loading" },
		]);
		expect(JSON.parse(fs.readFileSync(shared, "utf8"))).toEqual(FOREIGN);
	});

	it("still prefers the file the environment names, as the real run needs", () => {
		const named = path.join(root, "named.json");
		vi.stubEnv(mod.INFLIGHT_ENV, named);

		mod.enter(root, "/repo/a.test.ts", "loading");

		expect(JSON.parse(fs.readFileSync(named, "utf8")).open).toEqual([
			{ module: "/repo/a.test.ts", stage: "loading" },
		]);
	});
});

describe("it never costs the run", () => {
	it("survives a root it cannot write to", () => {
		const blocked = path.join(root, "not-a-dir");
		fs.writeFileSync(blocked, "x");

		expect(() => mod.begin(blocked)).not.toThrow();
		expect(() =>
			mod.enter(blocked, "/repo/a.test.ts", "loading"),
		).not.toThrow();
		expect(() => mod.leave(blocked, "/repo/a.test.ts")).not.toThrow();
		expect(() => mod.beat(blocked)).not.toThrow();
		expect(() => mod.clear(blocked)).not.toThrow();
	});

	it("reads an absent record's beat as never", () => {
		expect(mod.lastBeat(path.join(root, "absent.json"))).toBe(0);
	});

	it("reads a corrupt record as no record, rather than throwing at the reader", () => {
		fs.writeFileSync(recordAt(root), "{ not json");

		expect(mod.read(root)).toEqual([]);
	});

	it("reads an object as no record rather than indexing it", () => {
		fs.writeFileSync(recordAt(root), '{"module":"a"}');

		expect(mod.read(root)).toEqual([]);
	});

	it("records the run's schedule, and starts each run with none", () => {
		mod.schedule(root, ["/repo/a.test.ts", undefined, "/repo/b.test.ts"]);

		expect(mod.readRecord(recordAt(root)).scheduled).toEqual([
			"/repo/a.test.ts",
			"/repo/b.test.ts",
		]);

		mod.begin(root);

		expect(mod.readRecord(recordAt(root)).scheduled).toBeNull();
	});

	it("reads a record with no schedule as none recorded, never as an empty one", () => {
		fs.writeFileSync(recordAt(root), '{"open":[],"finished":[]}');

		expect(mod.readRecord(recordAt(root)).scheduled).toBeNull();
	});

	it("reads an absent file as no record", () => {
		mod.clear(root);

		expect(mod.read(root)).toEqual([]);
	});

	it("ignores a module with no id at all", () => {
		mod.enter(root, undefined, "loading");
		mod.leave(root, undefined);

		expect(mod.read(root)).toEqual([]);
	});
});
