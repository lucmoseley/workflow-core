// @vitest-environment node

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
import { shellQuote } from "./lib/sh-quote.js";

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "generate-doc-map-section-a.js");

const SYNTHETIC_MAP = syntheticDocMap({
	sectionA: "## Section A: register",
	subsections: [{ heading: "Docs", rows: [] }],
	after: ["## Section B: figures", "", "nothing here.", ""],
});

const threeEntrySidecar = () => syntheticSidecar(syntheticPaths(3));

let dir: string;
let mapPath: string;
let dataFile: string;
let claimLog: string;
let releaseLog: string;
let claimStub: string;
let releaseStub: string;

const writeStub = (file: string, log: string, code = 0) => {
	fs.writeFileSync(
		file,
		`#!/usr/bin/env bash\necho "$@" >> ${shellQuote(log)}\nexit ${code}\n`,
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

const readLog = (file: string) =>
	fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];

describe("generate-doc-map-section-a's claim", () => {
	it("claims §A and never the bare map", () => {
		const r = run();
		expect(r.status).toBe(0);
		expect(readLog(claimLog)).toEqual([`${mapPath}#section-a --generator`]);
	});

	it("releases §A once it has written, with the flag that gets past mantahostels#63", () => {
		expect(run().status).toBe(0);
		expect(readLog(releaseLog)).toEqual([`${mapPath}#section-a --generator`]);
	});

	it("releases §A when the write itself fails", () => {
		fs.chmodSync(mapPath, 0o444);
		const r = run();
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot write");
		expect(readLog(releaseLog)).toEqual([`${mapPath}#section-a --generator`]);
	});

	it("releases nothing when the arbiter refused the claim", () => {
		writeStub(claimStub, claimLog, 1);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("could not claim");
		expect(readLog(releaseLog)).toEqual([]);
	});

	it("takes and releases nothing under --no-claim", () => {
		expect(run("--no-claim").status).toBe(0);
		expect(readLog(claimLog)).toEqual([]);
		expect(readLog(releaseLog)).toEqual([]);
	});

	it("claims nothing on the paths that write nothing", () => {
		expect(run("--check").status).toBe(1);
		expect(readLog(claimLog)).toEqual([]);
	});
});

describe("the claim it gives back, against the real arbiter (mantahostels#2428)", () => {
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
		delete sidecar[Object.keys(sidecar)[0]];
		writeSidecar(repoData, sidecar);
	});

	const heldSubjects = () =>
		store
			.listLocks()
			.filter((l: { path: string }) => l.path.startsWith("docs/doc-map.md"))
			.map((l: { path: string }) => l.path);

	const realRun = (...args: string[]) =>
		runInProcess(SCRIPT, ["--map", repoMap, "--data-file", repoData, ...args]);

	const dropAKey = () => {
		const sidecar = JSON.parse(fs.readFileSync(repoData, "utf8"));
		delete sidecar[Object.keys(sidecar)[0]];
		writeSidecar(repoData, sidecar);
	};

	it("takes §A, writes, and drops it although the write left §A dirty", () => {
		live(sb, "sandbox");
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
