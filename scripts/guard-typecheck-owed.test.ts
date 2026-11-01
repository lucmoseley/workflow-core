// @vitest-environment node
/*
 * Pins the Stop guard that asks for a type-check after a commit's pre-commit try
 * found the slot held, off queue-run.js's exit log.
 *
 * Breaking it leaves that commit's first type report to CI (#3803), or nags a
 * session that has already had a type-check.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStopGuardBlock } from "./lib/stop-guard-testkit";

const require_ = createRequire(__filename);
const { queueExitLogPath } = require_("./lib/queue-exit-log.js");
const { MAX_BLOCKS } = require_("./lib/hook-block.js");

const GUARD = path.join(__dirname, "guard-typecheck-owed.js");
const SID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";

const HELD = {
	reason: "refused",
	noWait: true,
	at: "2026-11-01T15:00:00.000Z",
};
const OWN_RUN = { reason: "opened", waitS: 40 };

let root: string;

interface Line {
	at?: string;
	kind?: string;
	reason: string;
	waitS?: number;
	session?: string;
	noWait?: boolean;
	limb?: string;
}

const writeLog = (lines: Line[]) => {
	const file = queueExitLogPath(root);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		lines
			.map((l) => JSON.stringify({ waitS: 0, kind: "tsc", session: SID, ...l }))
			.map((l) => `${l}\n`)
			.join(""),
	);
};

const declareCommands = (commands: object) => {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ commands }),
	);
};

const run = () =>
	readStopGuardBlock(GUARD, { dir: root, sid: SID, message: "result: done." });

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tc-owed-")));
	execFileSync("git", ["init", "-q", "-b", "main", root]);
	declareCommands({ typecheck: "npm run typecheck" });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("guard-typecheck-owed", () => {
	it("blocks on a held try, naming its time and the command", () => {
		writeLog([HELD]);
		const reason = run()?.reason;
		expect(reason).toContain("found the slot held at 2026-11-01T15:00:00.000Z");
		expect(reason).toContain("npm run typecheck");
	});

	it("names the oldest held try since the last own run", () => {
		writeLog([
			{ ...HELD, at: "2026-11-01T10:00:00.000Z" },
			OWN_RUN,
			HELD,
			{ ...HELD, at: "2026-11-01T16:00:00.000Z" },
		]);
		expect(run()?.reason).toContain("held at 2026-11-01T15:00:00.000Z");
	});

	it("passes once an own run opened", () => {
		writeLog([HELD, OWN_RUN]);
		expect(run()).toBeNull();
	});

	it.each([
		["a later hook try that opened", { reason: "opened", noWait: true }],
		["an own run killed in the queue", { reason: "killed", waitS: 30 }],
		["an own run refused at the bound", { reason: "refused", waitS: 2400 }],
		["another kind's run", { reason: "opened", kind: "touched" }],
	])("still blocks after %s", (_name, later) => {
		writeLog([HELD, later]);
		expect(run()?.reason).toContain("found the slot held");
	});

	it("reads a held try that took over 500 ms as a try", () => {
		writeLog([{ ...HELD, waitS: 1 }]);
		expect(run()?.reason).toContain("found the slot held");
	});

	it("passes an own run refused at the bound with no held try", () => {
		writeLog([{ reason: "refused", waitS: 2400, limb: "count" }]);
		expect(run()).toBeNull();
	});

	it("never reads a neighbour's held try", () => {
		writeLog([OWN_RUN, { ...HELD, session: OTHER }]);
		expect(run()).toBeNull();
	});

	it("is silent where no type-check command is declared", () => {
		declareCommands({});
		writeLog([HELD]);
		expect(run()).toBeNull();
	});

	it("is silent with no log", () => {
		expect(run()).toBeNull();
	});

	it("skips an unparsable line", () => {
		const file = queueExitLogPath(root);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `{"kind":"tsc","session":"${SID}",\n`);
		expect(run()).toBeNull();
	});

	it("stops blocking at the cap", () => {
		writeLog([HELD]);
		for (let i = 0; i < MAX_BLOCKS; i++) expect(run()).not.toBeNull();
		expect(run()).toBeNull();
	});
});
