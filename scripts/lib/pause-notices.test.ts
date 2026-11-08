// @vitest-environment node
/*
 * lib/pause-notices.js's tendPauseNotices, called in-process as the tick calls it,
 * with `gh` through WFC_GH's route stub.
 *
 * Broken, a no-progress pause that only the founder can end goes unseen for hours
 * (#4200), or pages him every tick.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readText } from "./file-read.js";
import { readGhAnswer } from "./gh-fake";
import { printed, stubGhRoutes } from "./gh-stub";
import { tendPauseNotices } from "./pause-notices.js";
import { LOGGED_OUT, MIN, NOW } from "./repo-hold-fixture";

type Pause = import("./refill-decide.js").Pause;

let dir: string;
const at = (name: string) => path.join(dir, name);

/** A checkout tracked at `tracker`, paging from `noticeRepo` where given. */
const checkout = (name: string, tracker: string, noticeRepo?: string) => {
	const root = at(name);
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({
			tracker,
			...(noticeRepo
				? {
						founderNotice: {
							workflow: "notice.yml",
							repo: noticeRepo,
							mention: "someone-to-page",
						},
					}
				: {}),
		}),
	);
	return root;
};

let paging: string;
let silent: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pause-notices-"));
	paging = checkout("paging", "o/r", "o/r");
	silent = checkout("silent", "o/other");
	vi.stubEnv("WFC_REFILL_DIR", dir);
	vi.stubEnv("WFC_MODULES", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

const readGhLog = () => {
	const read = readText(at("gh-log"));
	return read.state === "read" ? read.data : "";
};
/** The markers of every dispatch so far, in order. */
const readDispatched = () =>
	[...readGhLog().matchAll(/<!-- (refill-pause-notice [^>]*) -->/g)].map(
		(m) => m[1] ?? "",
	);
const readPhases = () => readDispatched().map((m) => m.split(" ").at(-1));

/** gh for the calls that follow, each dispatch so far commented on issue 12. */
const serve = () => {
	const routes = fs.mkdtempSync(path.join(dir, "gh-routes-"));
	const comments = readDispatched().map((m) => ({
		body: `@x hello\n\n<!-- ${m} -->`,
	}));
	const { gh } = stubGhRoutes(
		routes,
		{
			"issue view 12 *": printed(JSON.stringify({ comments })),
			"run list *": printed("[]"),
			"workflow run *": printed(""),
			"*": readGhAnswer(LOGGED_OUT),
		},
		{ log: at("gh-log"), bodies: at("bodies") },
	);
	vi.stubEnv("WFC_GH", gh);
};

/** One tick's pause notices at `now` under `paused`; its log lines. */
const tick = (paused: Pause | undefined, now = NOW) => {
	serve();
	const lines: string[] = [];
	tendPauseNotices(paused, now, (l) => lines.push(l));
	expect(lines.join("\n")).not.toContain("notice not tended");
	return lines.join("\n");
};

const noProgress = (
	issues = [
		{ root: silent, number: 5 },
		{ root: paging, number: 12 },
	],
): Pause => ({ by: "no-progress", at: NOW - MIN, issues });

describe("a no-progress pause's phone notice (#4222)", () => {
	it("sends one raise the tick it is written, on the first issue in a paging tracker, and none on later paused ticks", () => {
		const pause = noProgress();
		expect(tick(pause)).toContain("raise notice dispatched on #12");
		tick(pause, NOW + MIN);
		tick(pause, NOW + 20 * MIN);
		expect(readPhases()).toEqual(["raise"]);
		expect(readGhLog()).toContain("-f issue=12");
		expect(readGhLog()).toContain("silent#5, paging#12");
		expect(readGhLog()).toContain("set --resume");
	});

	it("sends one clear once the pause ends, and nothing after", () => {
		const pause = noProgress();
		tick(pause);
		expect(tick(undefined, NOW + MIN)).toContain(
			"clear notice dispatched on #12",
		);
		tick(undefined, NOW + 2 * MIN);
		tick(undefined, NOW + 20 * MIN);
		expect(readPhases()).toEqual(["raise", "clear"]);
		expect(readGhLog().split("silent#5, paging#12")).toHaveLength(3);
		expect(fs.readdirSync(at("pause-notices"))).toEqual([]);
	});

	it("pages each pause as its own cause", () => {
		tick(noProgress());
		tick(undefined, NOW + MIN);
		tick({ ...noProgress(), at: NOW + 2 * MIN }, NOW + 3 * MIN);
		expect(readPhases()).toEqual(["raise", "clear", "raise"]);
	});

	it("reads a torn record as sent, logged, and pages neither raise nor clear", () => {
		const pause = noProgress();
		fs.mkdirSync(at("pause-notices"));
		fs.writeFileSync(at(`pause-notices/${pause.at}.notice`), "{");
		expect(tick(pause)).toContain("notice record torn, read as sent");
		tick(pause, NOW + MIN);
		tick(undefined, NOW + 2 * MIN);
		expect(readGhLog()).not.toContain("workflow run");
		expect(fs.readdirSync(at("pause-notices"))).toEqual([]);
	});

	it("logs a clear given up on a record torn after its raise", () => {
		const pause = noProgress();
		tick(pause);
		fs.writeFileSync(at(`pause-notices/${pause.at}.notice`), "{");
		expect(tick(undefined, NOW + MIN)).toContain("clear notice lost");
		expect(readPhases()).toEqual(["raise"]);
	});

	it("sends nothing for a founder-set pause", () => {
		tick({ by: "founder", at: NOW - MIN });
		tick(undefined, NOW + MIN);
		expect(readGhLog()).not.toContain("workflow run");
	});

	it("sends nothing for a pause with no issue in a paging tracker, logged once, and no clear", () => {
		const pause = noProgress([{ root: silent, number: 5 }]);
		expect(tick(pause)).toContain(
			"no phone notice, as none of silent#5 lives in a tracker",
		);
		expect(tick(pause, NOW + MIN)).toBe("");
		tick(undefined, NOW + 2 * MIN);
		expect(readGhLog()).not.toContain("workflow run");
		expect(fs.readdirSync(at("pause-notices"))).toEqual([]);
	});
});
