// @vitest-environment node
/*
 * test-inflight.js's on-disk record names every test module started and not
 * finished, beats on each event, and never throws (mantahostels#1910, #1149).
 *
 * The module holds its set in memory as well as on disk, so `begin` is called
 * at the top of every case that reads. Each case writes under its own temp
 * root, with the wrapper's live record simulated (mantahostels#2790, below).
 *
 * `run-vitest.js`'s watchdog reads the record on every `npm run test`; loosen
 * a case and a parked suite is killed naming no file, or a slow file is read
 * as parked and killed.
 */
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
} from "vitest";

const mod = require("./test-inflight.js");

let root: string;
let ambient: string | undefined;
let sharedDir: string;
let shared: string;

const FOREIGN = [{ module: "/other/live.test.ts", stage: "loading" }];

/** The record a bare run under `r` writes, the environment naming none. */
const recordAt = (r: string) =>
	path.join(r, ".claude", "tmp", "markers", ".test-inflight.json");

/* THE FULL-SUITE CONDITION IS SIMULATED HERE RATHER THAN WAITED FOR.
 * The module prefers WFC_INFLIGHT_FILE over the `root` argument — right
 * for the real run, where run-vitest.js names one per-run file every worker
 * shares — but the real run also SETS it, so every case below would otherwise
 * write to that live record and read back another worker's concurrent write
 * (mantahostels#2790). `beforeAll` therefore points the variable at a record of this
 * file's own, standing in for the wrapper's, and `beforeEach` unsets it per
 * case. Simulated rather than merely unset, because with no ambient variable to
 * defeat, dropping the unset leaves every case green. */
beforeAll(() => {
	sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-inflight-live-"));
	shared = path.join(sharedDir, "live.json");
	fs.writeFileSync(shared, `${JSON.stringify(FOREIGN)}\n`);
	ambient = process.env[mod.INFLIGHT_ENV];
	process.env[mod.INFLIGHT_ENV] = shared;
});

beforeEach(() => {
	delete process.env[mod.INFLIGHT_ENV];
	root = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-inflight-"));
	mod.begin(root);
});

afterEach(() => {
	process.env[mod.INFLIGHT_ENV] = shared;
	fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
	if (ambient === undefined) delete process.env[mod.INFLIGHT_ENV];
	else process.env[mod.INFLIGHT_ENV] = ambient;
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

	/* Collection sits between queue and end, so recording it must not read as
	 * the module leaving — a test-body stall would vanish from the record. */
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

/* The two halves of mantahostels#2790: the fixture must isolate these cases from the
 * wrapper's shared record, and must not do it by weakening the preference the
 * wrapper itself depends on. Both read the files themselves, by path. */
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
		process.env[mod.INFLIGHT_ENV] = named;

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

	it("reads an absent file as no record", () => {
		mod.clear(root);

		expect(mod.read(root)).toEqual([]);
	});

	/* vitest hands a module with no id where it could not resolve one; recording
	 * it would put a bare "undefined" in the report a stalled session reads. */
	it("ignores a module with no id at all", () => {
		mod.enter(root, undefined, "loading");
		mod.leave(root, undefined);

		expect(mod.read(root)).toEqual([]);
	});
});
