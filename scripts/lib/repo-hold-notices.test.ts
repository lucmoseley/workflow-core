// @vitest-environment node
/*
 * lib/repo-hold-notices.js's tendHoldNotices, called in-process over holds in a
 * real store, with `gh` through WFC_GH's route stub, which serves each dispatch
 * so far as its comment on the issue, as the workflow would. Where a case needs a
 * hold raised, filed or cleared as a tick would, it runs lib/repo-holds.js's
 * tendHolds over a real checkout. The tick's wiring of the notice, its one
 * dispatch adapter crossed, is refill-loop-run-holds.test.ts's (#4314).
 *
 * Broken, a hold that stops every launch reaches nobody's phone (#3871), or a
 * notice repeats every tick.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGhAnswer } from "./gh-fake";
import { page, printed, stubGhRoutes } from "./gh-stub";
import {
	ISSUE,
	LOGGED_OUT,
	MIN,
	NOW,
	probedCheckout,
} from "./repo-hold-fixture";
import { tendHoldNotices } from "./repo-hold-notices.js";
import {
	buildHoldLines,
	holdsDir,
	liftHold,
	raiseHold,
	readHolds,
	tendHolds,
} from "./repo-holds.js";
import { shellQuote } from "./sh-quote.js";
import { readConfig } from "./workflow-core-config.js";

let dir: string;
let repo: string;
const at = (name: string) => path.join(dir, name);

const writeConfig = (isNoticeOn = true) =>
	fs.writeFileSync(
		path.join(repo, ".claude", "workflow-core.json"),
		JSON.stringify({
			tracker: "o/r",
			...(isNoticeOn
				? {
						founderNotice: {
							workflow: "notice.yml",
							repo: "o/r",
							mention: "someone-to-page",
						},
					}
				: {}),
		}),
	);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-hold-notices-"));
	repo = at("repo");
	probedCheckout.instantiate(repo);
	fs.mkdirSync(path.join(repo, ".claude"));
	writeConfig();
	vi.stubEnv("WFC_REFILL_DIR", dir);
	vi.stubEnv("WFC_MODULES", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

const readGhLog = () =>
	fs.existsSync(at("gh-log")) ? fs.readFileSync(at("gh-log"), "utf8") : "";
/** The markers of every dispatch so far, in order. */
const readDispatched = () =>
	[...readGhLog().matchAll(/<!-- (repo-hold-notice [^>]*) -->/g)].map(
		(m) => m[1] ?? "",
	);
const readPhases = () => readDispatched().map((m) => m.split(" ").at(-1));

/**
 * gh for the calls that follow: each dispatch so far has its comment on the issue
 * unless `isRunDropped`; `isRefusing` refuses the dispatch; `runs` is the notice
 * workflow's run listing; `isFiling` false refuses a probe filing's label read.
 * Any other call answers logged out.
 */
const serve = ({
	isRefusing = false,
	isRunDropped = false,
	isFiling = true,
	runs = [] as { status: string }[],
} = {}) => {
	const routes = fs.mkdtempSync(path.join(dir, "gh-routes-"));
	const comments = isRunDropped
		? []
		: readDispatched().map((m) => ({ body: `@x hello\n\n<!-- ${m} -->` }));
	const { gh } = stubGhRoutes(
		routes,
		{
			"issue list *": printed("[]"),
			"repos/o/r/labels": isFiling
				? page("labelsPage", [{ name: "takes:triage" }])
				: readGhAnswer(LOGGED_OUT),
			"issue create *": printed(`https://github.com/o/r/issues/${ISSUE}\n`),
			[`issue close ${ISSUE} *`]: printed(""),
			[`issue view ${ISSUE} *`]: printed(JSON.stringify({ comments })),
			"run list *": printed(JSON.stringify(runs)),
			"workflow run *": isRefusing ? readGhAnswer(LOGGED_OUT) : printed(""),
			"*": readGhAnswer(LOGGED_OUT),
		},
		{ log: at("gh-log"), bodies: at("bodies") },
	);
	vi.stubEnv("WFC_GH", gh);
	return gh;
};

/* Just past lib/repo-hold-notices.js's windows: no slot at work for 30 min, a
 * sent notice unseen for 15 min, and its give-up after a day. */
const PAST_NO_WORK = 31 * MIN;
const PAST_UNSEEN = 16 * MIN;
const PAST_GIVE_UP = 25 * 60 * MIN;
/* Just past a probe hold's 6 h cool-down after its checkout's last page. */
const PAST_COOL_DOWN = 6 * 60 * MIN + MIN;

/* A background session that is not at work: no slot has worked. */
const IDLE = [{ state: "blocked", kind: "background" }];

/** One tick's notices at `now`, off `agents` and the pause; its log lines. */
const notices = (
	now = NOW,
	{
		agents = IDLE as { state?: string; kind?: string }[] | null,
		isPaused = false,
	} = {},
) => {
	const lines: string[] = [];
	tendHoldNotices([repo], { agents, isPaused }, now, (l) => lines.push(l));
	expect(lines.join("\n")).not.toContain("notice not tended");
	return lines.join("\n");
};

/** One tick's holds over the checkout at `now`; its log lines. */
const holdTick = (now = NOW) => {
	const lines: string[] = [];
	tendHolds([repo], [repo], now, (l) => lines.push(l));
	return lines.join("\n");
};

const status = (now = NOW) => buildHoldLines([repo], now).join("\n");

const raisePark = (act = "repair main") =>
	raiseHold(repo, {
		kind: "park",
		act,
		issue: ISSUE,
		clearCheck: { command: "test -f fixed" },
		session: null,
		now: NOW,
	});
const raiseProbe = (now = NOW) =>
	raiseHold(repo, {
		id: "probe",
		kind: "probe",
		act: "repair the shared tree: resolve main: names no commit",
		issue: ISSUE,
		clearCheck: { probe: true },
		session: null,
		now,
	});

const lastWorked = () => at("last-slot-worked.json");
/** When a slot last worked, as the tick a minute before `now` read it. */
const slotWorkedAgo = (ms: number, now = NOW) =>
	fs.writeFileSync(
		lastWorked(),
		JSON.stringify({ workedAt: now - ms, tickedAt: now - MIN }),
	);

const breakHead = () =>
	fs.writeFileSync(path.join(repo, ".git", "HEAD"), "junk\n");
const repairHead = () =>
	fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
const noticeFile = (id: string) => path.join(holdsDir(repo), `${id}.notice`);

describe("a park hold's raise notice (#3871)", () => {
	it("sends nothing while a slot worked in the last 30 min, and once when that lapses", () => {
		serve();
		raisePark();
		slotWorkedAgo(5 * MIN);
		notices();
		expect(readPhases()).toEqual([]);

		slotWorkedAgo(PAST_NO_WORK);
		notices();
		expect(readPhases()).toEqual(["raise"]);

		serve();
		notices(NOW + MIN);
		slotWorkedAgo(PAST_NO_WORK, NOW + 2 * MIN);
		notices(NOW + 2 * MIN);
		expect(readPhases()).toEqual(["raise"]);
	});

	it("starts the 30 min again for a loop that has not ticked for them", () => {
		serve();
		raisePark();
		fs.writeFileSync(
			lastWorked(),
			JSON.stringify({
				workedAt: NOW - 24 * 60 * MIN,
				tickedAt: NOW - 24 * 60 * MIN,
			}),
		);
		notices();
		expect(readPhases()).toEqual([]);
	});

	it("counts a working session as a slot that has worked", () => {
		serve();
		raisePark();
		slotWorkedAgo(PAST_NO_WORK);
		notices(NOW, { agents: [{ state: "working", kind: "background" }] });
		expect(readPhases()).toEqual([]);
	});

	it("does not count the 30 min while the loop is paused", () => {
		serve();
		raisePark();
		slotWorkedAgo(PAST_NO_WORK);
		notices(NOW, { isPaused: true });
		expect(readPhases()).toEqual([]);
		expect(JSON.parse(fs.readFileSync(lastWorked(), "utf8")).workedAt).toBe(
			NOW,
		);
	});

	it("breaks a mention in the act's text, so it pages nobody it names", () => {
		serve();
		raisePark("ask @stranger to repair main");
		slotWorkedAgo(PAST_NO_WORK);
		notices();
		expect(readGhLog()).toContain("ask @​stranger");
		expect(readGhLog()).not.toContain("@stranger");
	});

	it("sends a clear for one lifted by hand, once its raise went", () => {
		serve();
		const { id } = raisePark();
		slotWorkedAgo(PAST_NO_WORK);
		notices();
		expect(readPhases()).toEqual(["raise"]);

		liftHold(repo, id);
		serve();
		notices(NOW + MIN);
		expect(readPhases()).toEqual(["raise", "clear"]);
	});

	it("sends neither for one cleared before its raise notice went", () => {
		serve();
		raisePark();
		slotWorkedAgo(5 * MIN);
		notices();
		fs.writeFileSync(path.join(repo, "fixed"), "");

		expect(holdTick(NOW + MIN)).toContain("repo hold cleared");
		notices(NOW + MIN);

		expect(readGhLog()).not.toContain("workflow run");
	});

	it("gives up a notice whose issue never reads, so its record does not stay for good", () => {
		serve();
		const { id } = raisePark();
		slotWorkedAgo(PAST_NO_WORK);
		notices();
		const routes = fs.mkdtempSync(path.join(dir, "gh-routes-"));
		vi.stubEnv(
			"WFC_GH",
			stubGhRoutes(routes, { "*": readGhAnswer(LOGGED_OUT) }).gh,
		);

		const given = notices(NOW + PAST_GIVE_UP);

		expect(given).toContain("raise notice lost");
		expect(fs.existsSync(noticeFile(id))).toBe(true);
		expect(status(NOW + PAST_GIVE_UP)).toContain("notice: raise lost");
	});
});

describe("a probe hold's notices (#3871)", () => {
	it("logs a refused dispatch, retries it next tick, and sends only one once it succeeds", () => {
		raiseProbe();
		serve({ isRefusing: true });
		expect(notices()).toContain(
			"raise notice not dispatched, the next tick retries",
		);
		expect(status()).toContain("notice: raise not sent");
		expect(readPhases()).toHaveLength(1);

		serve();
		notices(NOW + MIN);
		expect(readPhases()).toHaveLength(2);

		serve();
		notices(NOW + 2 * MIN);
		expect(readPhases()).toHaveLength(2);
	});

	it("dispatches once more where a run was lost, then reads the notice lost and sends no third", () => {
		raiseProbe();
		serve({ isRunDropped: true });
		notices();
		expect(readPhases()).toEqual(["raise"]);

		notices(NOW + MIN);
		expect(readPhases()).toEqual(["raise"]);

		notices(NOW + PAST_UNSEEN);
		expect(readPhases()).toEqual(["raise", "raise"]);

		const lost = notices(NOW + 2 * PAST_UNSEEN);
		expect(lost).toContain("raise notice lost");
		expect(readPhases()).toEqual(["raise", "raise"]);
		expect(status(NOW + 2 * PAST_UNSEEN)).toContain("notice: raise lost");
	});

	it("waits on a run still queued rather than page twice", () => {
		raiseProbe();
		serve({ isRunDropped: true });
		notices();

		serve({ isRunDropped: true, runs: [{ status: "queued" }] });
		notices(NOW + PAST_UNSEEN);
		expect(readPhases()).toEqual(["raise"]);
	});

	it("treats a dispatch whose gh never exited as taken, checking before any second", () => {
		raiseProbe();
		const routed = serve();
		const killed = at("gh-killed");
		fs.writeFileSync(
			killed,
			`#!/bin/sh
if [ "$1 $2" = "workflow run" ]; then printf '%s\\n' "$*" >> ${shellQuote(at("gh-log"))}; kill -TERM $$; fi
exec ${shellQuote(routed)} "$@"
`,
			{ mode: 0o755 },
		);
		vi.stubEnv("WFC_GH", killed);
		expect(notices()).toContain("gh never exited, so it may have gone");
		expect(readPhases()).toEqual(["raise"]);

		serve();
		notices(NOW + MIN);
		expect(readPhases()).toEqual(["raise"]);
	});

	it("sends nothing and logs one line with the configuration unset", () => {
		writeConfig(false);
		serve();
		raiseProbe();
		const first = notices();
		const second = notices(NOW + MIN);
		expect(holdTick(NOW + 2 * MIN)).toContain("repo hold cleared: probe in");
		const third = notices(NOW + 2 * MIN);

		expect(readGhLog()).not.toContain("workflow run");
		expect((first + second + third).match(/no phone notice/g)).toHaveLength(1);
	});

	it("sends no clear after a lost raise", () => {
		raiseProbe();
		serve({ isRunDropped: true });
		notices();
		notices(NOW + PAST_UNSEEN);
		notices(NOW + 2 * PAST_UNSEEN);
		expect(holdTick(NOW + 2 * PAST_UNSEEN + MIN)).toContain(
			"repo hold cleared: probe in",
		);

		notices(NOW + 2 * PAST_UNSEEN + MIN);

		expect(readPhases()).toEqual(["raise", "raise"]);
	});

	it("sends nothing and reports a notice file that will not read", () => {
		raiseProbe();
		serve();
		notices();
		fs.writeFileSync(noticeFile("probe"), "{ torn");

		serve();
		notices(NOW + MIN);

		expect(readHolds(repo).unread.join("\n")).toContain("not its notice state");
		expect(readPhases()).toEqual(["raise"]);
		expect(status(NOW + MIN)).toContain("not its notice state");
	});

	it("retries its notice with its filing", () => {
		serve({ isFiling: false });
		breakHead();
		holdTick();
		notices();
		expect(readPhases()).toEqual([]);

		serve();
		expect(holdTick(NOW + MIN)).toContain(`filed #${ISSUE}`);
		notices(NOW + MIN);
		expect(readPhases()).toEqual(["raise"]);
	});

	it("sends neither for one that clears with its filing never landed", () => {
		serve({ isFiling: false });
		breakHead();
		holdTick();
		notices();
		repairHead();

		expect(holdTick(NOW + MIN)).toContain("repo hold cleared: probe in");
		notices(NOW + MIN);

		expect(readGhLog()).not.toContain("workflow run");
	});
});

describe("a probe hold that comes back (#4148)", () => {
	/** Raise a probe hold at `now` and tend its notices; that tick's log. */
	const raiseAndTend = (now: number) => {
		raiseProbe(now);
		serve();
		return notices(now);
	};
	/** Clear the open probe hold at `now`, as the passing probe would, and tend. */
	const clearAndTend = (now: number) => {
		serve();
		expect(holdTick(now)).toContain("repo hold cleared: probe in");
		return notices(now);
	};

	it("sends no second raise inside the cool-down, nor a clear for one withheld", () => {
		raiseAndTend(NOW);
		clearAndTend(NOW + MIN);
		expect(readPhases()).toEqual(["raise", "clear"]);

		raiseAndTend(NOW + 20 * MIN);
		clearAndTend(NOW + 21 * MIN);
		raiseAndTend(NOW + 40 * MIN);

		expect(readPhases()).toEqual(["raise", "clear"]);
	});

	it("sends one raise for a hold still open when the cool-down ends", () => {
		raiseAndTend(NOW);
		clearAndTend(NOW + MIN);
		raiseAndTend(NOW + 20 * MIN);

		serve();
		notices(NOW + MIN + PAST_COOL_DOWN);
		serve();
		notices(NOW + 2 * MIN + PAST_COOL_DOWN);

		expect(readPhases()).toEqual(["raise", "clear", "raise"]);
		clearAndTend(NOW + 3 * MIN + PAST_COOL_DOWN);
		expect(readPhases()).toEqual(["raise", "clear", "raise", "clear"]);
	});

	it("sends no second raise for one raised again over a torn record, which drops its notice file", () => {
		raiseAndTend(NOW);
		expect(fs.existsSync(noticeFile("probe"))).toBe(true);

		raiseAndTend(NOW + MIN);

		expect(fs.existsSync(noticeFile("probe"))).toBe(false);
		expect(readPhases()).toEqual(["raise"]);
	});

	it("reads a torn page record as a page now, logged, and sends once its cool-down ends", () => {
		fs.mkdirSync(holdsDir(repo), { recursive: true });
		fs.writeFileSync(path.join(holdsDir(repo), "probe.paged"), "{ torn");

		expect(raiseAndTend(NOW)).toContain("probe page record torn");
		expect(readPhases()).toEqual([]);

		serve();
		notices(NOW + PAST_COOL_DOWN);
		expect(readPhases()).toEqual(["raise"]);
	});

	it("leaves a park hold's raise to its own rule", () => {
		raiseAndTend(NOW);
		raisePark();
		slotWorkedAgo(PAST_NO_WORK, NOW + MIN);
		serve();
		notices(NOW + MIN);

		expect(readPhases()).toEqual(["raise", "raise"]);
	});
});

it("has this host's configuration set, so the notice is on for this repo", () => {
	const root = path.join(__dirname, "..", "..");
	const declared = JSON.parse(
		fs.readFileSync(path.join(root, ".claude/workflow-core.json"), "utf8"),
	);
	const { founderNotice } = readConfig({ root, quiet: true });
	expect(founderNotice).toEqual(declared.founderNotice);
	expect(founderNotice).toEqual({
		workflow: "founder-notice.yml",
		repo: "lucmoseley/workflow-core-tracker",
		mention: "lucmoseley",
	});
});
