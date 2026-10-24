// @vitest-environment node
/*
 * Pins that the §A generator claims `docs/doc-map.md`'s §A, never the whole map,
 * and gives the claim back on every path that writes.
 *
 * generate-doc-map-section-a.js's own suite — the claim it takes over §A and
 * gives back (mantahostels#2422). The rendering itself is proved in lib/doc-map.test.ts.
 *
 * The first block's claim and release commands are stubs that log their subject:
 * the real arbiter would answer for the repo's own docs/doc-map.md, which this
 * must not touch. The second block runs the real arbiter — against a sandbox
 * store and a sandbox repo, which is what makes that safe.
 *
 * Every §A registration runs it (`npm run gen:doc-map-section-a`): loosen a case
 * and one run locks the map, or §A, against every other session until its
 * process ends.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	commitAll,
	core,
	freshSandbox,
	gitRepo,
	live,
	store,
} from "./lib/arbiter-testkit";
import {
	syntheticDocMap,
	syntheticPaths,
	syntheticSidecar,
	writeSidecar,
} from "./lib/doc-map-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "generate-doc-map-section-a.js");

/** A minimal but valid doc-map.md: one §A subsection with an empty register
 * table, followed by §Section B — enough for renderSectionA to find both the
 * table to swallow and the boundary that ends §A. */
const SYNTHETIC_MAP = syntheticDocMap({
	sectionA: "## Section A: register",
	subsections: [{ heading: "Docs", rows: [] }],
	after: ["## Section B: figures", "", "nothing here.", ""],
});

/** A matching sidecar: three entries, so the second describe block — which
 * drops one key twice (once here, once in `dropAKey`) — still leaves a
 * non-empty sidecar (loadDocClasses refuses an empty one). */
const threeEntrySidecar = () => syntheticSidecar(syntheticPaths(3));

let dir: string;
let mapPath: string;
let dataFile: string;
let claimLog: string;
let releaseLog: string;
let claimStub: string;
let releaseStub: string;

/** A stub standing in for the arbiter: logs its arguments, exits `code`. */
const writeStub = (file: string, log: string, code = 0) => {
	fs.writeFileSync(
		file,
		`#!/usr/bin/env bash\necho "$@" >> "${log}"\nexit ${code}\n`,
	);
	fs.chmodSync(file, 0o755);
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-section-a-"));
	mapPath = path.join(dir, "doc-map.md");
	dataFile = path.join(dir, "doc-map-classes.json");
	claimLog = path.join(dir, "claim.log");
	releaseLog = path.join(dir, "release.log");
	claimStub = path.join(dir, "claim-stub.sh");
	releaseStub = path.join(dir, "release-stub.sh");
	writeStub(claimStub, claimLog);
	writeStub(releaseStub, releaseLog);

	fs.writeFileSync(mapPath, SYNTHETIC_MAP);
	const sidecar = threeEntrySidecar();
	// One key short, so the render differs from the seed map and the run
	// reaches its write rather than the already-matches exit.
	delete sidecar[Object.keys(sidecar)[0]];
	writeSidecar(dataFile, sidecar);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, [
		"--map",
		mapPath,
		"--data-file",
		dataFile,
		"--claim-cmd",
		claimStub,
		"--release-cmd",
		releaseStub,
		...args,
	]);
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const logged = (file: string) =>
	fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];

describe("generate-doc-map-section-a's claim", () => {
	it("claims §A and never the bare map", () => {
		const r = run();
		expect(r.status).toBe(0);
		expect(logged(claimLog)).toEqual([`${mapPath}#section-a --generator`]);
	});

	it("releases §A once it has written, with the flag that gets past mantahostels#63", () => {
		// --generator on the release too (mantahostels#2428): the write this run just made is
		// what makes §A dirty, and a dirty subject is refused without it.
		expect(run().status).toBe(0);
		expect(logged(releaseLog)).toEqual([`${mapPath}#section-a --generator`]);
	});

	it("releases §A when the write itself fails", () => {
		fs.chmodSync(mapPath, 0o444);
		const r = run();
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot write");
		expect(logged(releaseLog)).toEqual([`${mapPath}#section-a --generator`]);
	});

	it("releases nothing when the arbiter refused the claim", () => {
		// The claim fails OPEN, so the write still happens — but releasing a claim
		// that was never granted would ask the arbiter to drop somebody else's.
		writeStub(claimStub, claimLog, 1);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("could not claim");
		expect(logged(releaseLog)).toEqual([]);
	});

	it("takes and releases nothing under --no-claim", () => {
		expect(run("--no-claim").status).toBe(0);
		expect(logged(claimLog)).toEqual([]);
		expect(logged(releaseLog)).toEqual([]);
	});

	it("claims nothing on the paths that write nothing", () => {
		// --check and the already-matches exit both return before the claim, so a
		// read-only run locks nobody out.
		expect(run("--check").status).toBe(1);
		expect(logged(claimLog)).toEqual([]);
	});
});

describe("the claim it gives back, against the real arbiter (mantahostels#2428)", () => {
	/*
	 * THE MECHANISM THIS EXERCISES: the release's own `--generator`, which waives
	 * the dirty refusal on §A. Not the alternative mantahostels#2428 weighed — widening
	 * post-commit's give-back to region locks — so nothing here commits.
	 */
	const sb = freshSandbox();
	let repoMap: string;
	let repoData: string;

	beforeEach(() => {
		gitRepo(sb);
		repoMap = path.join(sb.repo, "docs/doc-map.md");
		repoData = path.join(sb.repo, "docs/doc-map-classes.json");
		fs.mkdirSync(path.dirname(repoMap), { recursive: true });
		fs.writeFileSync(repoMap, SYNTHETIC_MAP);
		const sidecar = threeEntrySidecar();
		writeSidecar(repoData, sidecar);
		commitAll(sb);
		// One key short, and AFTER the commit: the run must reach its write, and
		// that write is what leaves §A dirty against HEAD.
		delete sidecar[Object.keys(sidecar)[0]];
		writeSidecar(repoData, sidecar);
	});

	/** Every claim standing on the sandbox's map, by subject. */
	const heldSubjects = () =>
		store
			.listLocks()
			.filter((l: { path: string }) => l.path.startsWith("docs/doc-map.md"))
			.map((l: { path: string }) => l.path);

	/** The generator, with the real arbiter on both ends. */
	const realRun = (...args: string[]) =>
		runInProcess(SCRIPT, ["--map", repoMap, "--data-file", repoData, ...args]);

	const dropAKey = () => {
		const sidecar = JSON.parse(fs.readFileSync(repoData, "utf8"));
		delete sidecar[Object.keys(sidecar)[0]];
		writeSidecar(repoData, sidecar);
	};

	it("takes §A, writes, and drops it although the write left §A dirty", () => {
		live(sb, "sandbox");
		// The control first: with the release stubbed out to a no-op, the same run
		// leaves the claim standing — so the empty store below is a release that
		// worked, not a claim that was never taken.
		const noop = path.join(sb.dir, "noop.sh");
		fs.writeFileSync(noop, "#!/usr/bin/env bash\nexit 0\n");
		fs.chmodSync(noop, 0o755);
		expect(realRun("--release-cmd", noop).status).toBe(0);
		expect(core.subjectDirty("docs/doc-map.md#section-a")).toBe(true);
		expect(heldSubjects()).toEqual(["docs/doc-map.md#section-a"]);

		dropAKey();
		const r = realRun();
		expect(`${r.stdout}${r.stderr}`).not.toContain("could not claim");
		expect(core.subjectDirty("docs/doc-map.md#section-a")).toBe(true);
		expect(r.status).toBe(0);
		expect(heldSubjects()).toEqual([]);
	});
});
