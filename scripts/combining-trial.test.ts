// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PDB,
	PDB_KEY,
	writeCdb,
	writeSchtasks,
	writeWslpath,
} from "./lib/combining-trial-fake";
import { printed, stubGhRoutes } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process.js";

const TRIAL = path.join(__dirname, "combining-trial.js");
const SCAN = path.join(__dirname, "pfn-scan.js");
const TRACKER = "o/tracker";
const COMMENT_URL = "https://github.com/o/tracker/issues/1#issuecomment-1\n";
const commentArgs = (issue: number) =>
	`issue comment ${issue} --repo ${TRACKER} --body-file -`;

let dir: string;
let diag: string;
let bin: string;
let dump: string;
const read = (file: string) =>
	fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const ghCalls = () =>
	read(path.join(dir, "gh.log")).split("\n").filter(Boolean);
const ghBodies = () => read(path.join(dir, "gh.bodies"));

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "combining-trial-"));
	diag = path.join(dir, "diag");
	bin = path.join(dir, "bin");
	dump = path.join(diag, "dumps", "live-261128-0700.dmp");
	fs.mkdirSync(path.join(diag, "sym", PDB, PDB_KEY), { recursive: true });
	fs.writeFileSync(path.join(diag, "sym", PDB, PDB_KEY, PDB), "");
	fs.mkdirSync(path.dirname(dump));
	fs.mkdirSync(path.join(dir, ".claude"));
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: TRACKER }),
	);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const envWith = ({
	cdb = {},
	tasks = {},
}: {
	cdb?: Parameters<typeof writeCdb>[1];
	tasks?: Parameters<typeof writeSchtasks>[2];
} = {}) => ({
	...process.env,
	CLAUDE_PROJECT_DIR: dir,
	WFC_DIAG_DIR: diag,
	WFC_WSLPATH: writeWslpath(bin),
	WFC_GH: stubGhRoutes(
		dir,
		Object.fromEntries(
			[5743, 77].map((n) => [commentArgs(n), printed(COMMENT_URL)]),
		),
		{ log: path.join(dir, "gh.log"), bodies: path.join(dir, "gh.bodies") },
	).gh,
	WFC_CDB: writeCdb(bin, cdb),
	WFC_SCHTASKS: writeSchtasks(bin, diag, tasks),
});

const MORNING_TASKS = () => ({
	"Verifier 5743 live dump": {
		log: "dumps.log",
		line: `ok path=${dump} bytes=768`,
	},
	"Verifier 5743 combining off": {
		log: "combining.log",
		line: "off PageCombining=False",
	},
});

describe("combining-trial", () => {
	it("exits 2 on an unknown run, printing the usage", () => {
		const r = runInProcess(TRIAL, ["noon"], { env: process.env });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("combining-trial.js night | morning");
	});

	it("exits 0 on a night after the Verifier pass ended, starting no task", () => {
		fs.writeFileSync(path.join(diag, "ended.txt"), "");
		const r = runInProcess(TRIAL, ["night"], { env: envWith() });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("the Verifier pass has ended");
		expect(ghCalls()).toEqual([]);
	});

	it("exits 0 on a morning whose dump and off both log, posting the scan's report to gh", () => {
		const r = runInProcess(TRIAL, ["morning"], {
			env: envWith({ tasks: MORNING_TASKS() }),
		});
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(ghCalls()).toEqual([commentArgs(5743)]);
		expect(ghBodies()).toContain("live-261128-0700.dmp");
		expect(ghBodies()).toContain(
			"last combining.log line before the dump: `none`",
		);
		expect(fs.existsSync(`${dump}.pfnscan.json`)).toBe(true);
	});

	it("exits 1 on a morning whose tasks cannot start, posting each problem's body to gh", () => {
		const r = runInProcess(TRIAL, ["morning"], { env: envWith() });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not start 'Verifier 5743 live dump': ");
		expect(ghCalls()).toEqual([commentArgs(5743), commentArgs(5743)]);
		expect(ghBodies()).toMatch(
			/^\*\*Page combining did not turn off\*\*.*\(#5804's morning run\)\*\*No live dump this morning\*\*.*\(#5804's morning run\)$/,
		);
	});

	it("exits 1 where combining.log cannot be read", () => {
		fs.mkdirSync(path.join(diag, "combining.log"));
		const r = runInProcess(TRIAL, ["morning"], { env: envWith() });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("combining-trial: combining.log: EISDIR");
		expect(ghCalls()).toEqual([]);
	});
});

describe("pfn-scan", () => {
	it("exits 2 where --post is not an issue number", () => {
		const r = runInProcess(SCAN, ["x.dmp", "--post", "abc"], {
			env: process.env,
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--post takes an issue number: abc");
	});

	it("exits 0 on a scan, printing the report and posting the same body to gh", () => {
		const r = runInProcess(
			SCAN,
			[dump, "--combining", "on all night", "--post", "77"],
			{ env: envWith() },
		);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("on all night");
		expect(ghCalls()).toEqual([commentArgs(77)]);
		expect(ghBodies()).toBe(r.stdout.replace(/\n$/, ""));
	});

	it("exits 1 where cdb fails, posting nothing", () => {
		const r = runInProcess(SCAN, [dump, "--post", "77"], {
			env: envWith({ cdb: { exit: 3 } }),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toBe("pfn-scan: cdb exited 3: cannot open the dump\n");
		expect(ghCalls()).toEqual([]);
	});
});
