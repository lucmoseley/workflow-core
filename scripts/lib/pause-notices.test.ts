// @vitest-environment node
import crypto from "node:crypto";
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
const readDispatched = () =>
	[...readGhLog().matchAll(/<!-- (refill-pause-notice [^>]*) -->/g)].map(
		(m) => m[1] ?? "",
	);
const readPhases = () => readDispatched().map((m) => m.split(" ").at(-1));

const serve = () => {
	const routes = fs.mkdtempSync(path.join(dir, "gh-routes-"));
	const comments = readDispatched().map((m) => ({
		body: `@x hello\n\n<!-- ${m} -->`,
	}));
	const viewed = printed(JSON.stringify({ comments }));
	const { gh } = stubGhRoutes(
		routes,
		{
			"issue view 12 *": viewed,
			[`issue view ${FILED} *`]: viewed,
			"run list *": printed("[]"),
			"workflow run *": printed(""),
			"*": readGhAnswer(LOGGED_OUT),
		},
		{ log: at("gh-log"), bodies: at("bodies") },
	);
	vi.stubEnv("WFC_GH", gh);
};

const FILED = 77;

const stubFiler = (fails = false) => {
	const calls: string[] = [];
	const filer = {
		home: paging,
		file: (title: string, body: string) => {
			calls.push(`file ${title} | ${body}`);
			return fails ? "gh is down" : FILED;
		},
		close: (n: number, comment: string) => {
			calls.push(`close ${n} ${comment}`);
			return null;
		},
	};
	return { filer, calls };
};

const tick = (
	repoPaused: Record<string, Pause>,
	now = NOW,
	filer = stubFiler().filer,
) => {
	serve();
	const lines: string[] = [];
	tendPauseNotices(repoPaused, now, (l) => lines.push(l), filer);
	expect(lines.join("\n")).not.toContain("notice not tended");
	return lines.join("\n");
};

const noProgress = (
	issues = [
		{ root: silent, number: 5 },
		{ root: paging, number: 12 },
	],
): Pause => ({ by: "no-progress", at: NOW - MIN, issues });

const noticeFileOf = (pausedAt: number, root: string) =>
	at(
		`pause-notices/${pausedAt}-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 12)}.notice`,
	);

describe("a checkout's no-progress pause's phone notice (#4222, #5275)", () => {
	it("sends one raise the tick it is written, on the first issue in a paging tracker, and none on later paused ticks", () => {
		const paused = { [paging]: noProgress() };
		expect(tick(paused)).toContain("raise notice dispatched on #12");
		tick(paused, NOW + MIN);
		tick(paused, NOW + 20 * MIN);
		expect(readPhases()).toEqual(["raise"]);
		expect(readGhLog()).toContain("-f issue=12");
		expect(readGhLog()).toContain("The refill loop paused paging");
		expect(readGhLog()).toContain("silent#5, paging#12");
		expect(readGhLog()).toContain("set --resume");
	});

	it("sends one clear once the pause ends, and nothing after", () => {
		tick({ [paging]: noProgress() });
		expect(tick({}, NOW + MIN)).toContain("clear notice dispatched on #12");
		tick({}, NOW + 2 * MIN);
		tick({}, NOW + 20 * MIN);
		expect(readPhases()).toEqual(["raise", "clear"]);
		expect(readGhLog().split("silent#5, paging#12")).toHaveLength(3);
		expect(fs.readdirSync(at("pause-notices"))).toEqual([]);
	});

	it("pages each pause as its own cause, two checkouts' at one time included", () => {
		tick({ [paging]: noProgress() });
		tick({}, NOW + MIN);
		tick({ [paging]: { ...noProgress(), at: NOW + 2 * MIN } }, NOW + 3 * MIN);
		expect(readPhases()).toEqual(["raise", "clear", "raise"]);
		tick(
			{
				[paging]: { ...noProgress(), at: NOW + 2 * MIN },
				[silent]: { ...noProgress(), at: NOW + 2 * MIN },
			},
			NOW + 4 * MIN,
		);
		expect(readPhases()).toEqual(["raise", "clear", "raise", "raise"]);
	});

	it("reads a torn record as sent, logged, and pages neither raise nor clear", () => {
		const pause = noProgress();
		fs.mkdirSync(at("pause-notices"));
		fs.writeFileSync(noticeFileOf(pause.at, paging), "{");
		expect(tick({ [paging]: pause })).toContain(
			"notice record torn, read as sent",
		);
		tick({ [paging]: pause }, NOW + MIN);
		tick({}, NOW + 2 * MIN);
		expect(readGhLog()).not.toContain("workflow run");
		expect(fs.readdirSync(at("pause-notices"))).toEqual([]);
	});

	it("logs a clear given up on a record torn after its raise", () => {
		const pause = noProgress();
		tick({ [paging]: pause });
		fs.writeFileSync(noticeFileOf(pause.at, paging), "{");
		expect(tick({}, NOW + MIN)).toContain("clear notice lost");
		expect(readPhases()).toEqual(["raise"]);
	});
});

describe("a pause whose tracker pages no one (#5275)", () => {
	const quiet = () => noProgress([{ root: silent, number: 5 }]);

	it("files one workflow-core issue naming the checkout, and pages on it", () => {
		const { filer, calls } = stubFiler();
		expect(tick({ [silent]: quiet() }, NOW, filer)).toContain(
			`filed #${FILED}, silent's tracker paging no one`,
		);
		tick({ [silent]: quiet() }, NOW + MIN, filer);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain(
			"file Refill loop: no-progress pause in silent |",
		);
		expect(calls[0]).toContain(silent);
		expect(calls[0]).toContain("silent#5");
		expect(readPhases()).toEqual(["raise"]);
		expect(readGhLog()).toContain(`-f issue=${FILED}`);
	});

	it("closes that issue once the pause ends, after its clear", () => {
		const { filer, calls } = stubFiler();
		tick({ [silent]: quiet() }, NOW, filer);
		expect(tick({}, NOW + MIN, filer)).toContain(
			`clear notice dispatched on #${FILED}`,
		);
		expect(calls.filter((c) => c.startsWith("close"))).toEqual([]);
		tick({}, NOW + 2 * MIN, filer);
		tick({}, NOW + 20 * MIN, filer);
		tick({}, NOW + 21 * MIN, filer);
		expect(calls.filter((c) => c.startsWith("close"))).toEqual([
			`close ${FILED} The refill loop's pause of \`${silent}\` has ended: it launches there again.`,
		]);
		expect(fs.readdirSync(at("pause-notices"))).toEqual([]);
	});

	it("logs a filing that fails and retries it the next tick, paging nothing meanwhile", () => {
		const down = stubFiler(true);
		expect(tick({ [silent]: quiet() }, NOW, down.filer)).toContain(
			"workflow-core issue not filed, the next tick retries: gh is down",
		);
		expect(readGhLog()).not.toContain("workflow run");
		const up = stubFiler();
		tick({ [silent]: quiet() }, NOW + MIN, up.filer);
		expect(up.calls).toHaveLength(1);
		expect(readPhases()).toEqual(["raise"]);
	});
});
