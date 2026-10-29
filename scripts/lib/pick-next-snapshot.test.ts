/*
 * pick-next's last-run snapshot, read for why an issue went unlaunched
 * (#2693). Break it and every stuck-urgent line in the morning review reads
 * "pick-next does not say why", or names a reason from another tracker.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";

const {
	readSnapshot,
	snapshotFile,
	whyNotLaunched,
} = require("./pick-next-snapshot.js");

const sb = freshSandbox();

const AT = "2026-10-18T06:55:00Z";
const snapshot = {
	generatedAt: AT,
	repo: "{owner}/{repo}",
	argv: ["--json"],
	excluded: [{ number: 1, reason: "blocked by #9" }],
	waiting: [
		{ number: 1, days: 3 },
		{ number: 2, days: 4 },
		{ number: 8, days: 5 },
	],
	notLaunched: [
		{ number: 2, reason: "no admission slot" },
		{ number: 3, reason: "no command", detail: { takes: ["human"] } },
		{ number: 4, reason: "no admission slot", detail: {} },
	],
	parked: [{ number: 1 }, { number: 7 }, { number: 8 }],
	frontier: [
		{ number: 2 },
		{ number: 3 },
		{ number: 4 },
		{ number: 5 },
		{ number: 7 },
	],
};

describe("whyNotLaunched (#2693)", () => {
	it("takes the exclusion, then the park, then the wait, then the not-launched reason with its takes, then the launch set", () => {
		expect(whyNotLaunched(snapshot, 1)).toBe(
			`blocked by #9 (pick-next, ${AT})`,
		);
		expect(whyNotLaunched(snapshot, 2)).toBe(
			`waiting on someone outside for 4 days (pick-next, ${AT})`,
		);
		expect(whyNotLaunched(snapshot, 3)).toBe(
			`no command (takes: human) (pick-next, ${AT})`,
		);
		expect(whyNotLaunched(snapshot, 4)).toBe(
			`no admission slot (pick-next, ${AT})`,
		);
		expect(whyNotLaunched(snapshot, 5)).toBe(
			`in its launch set (pick-next, ${AT})`,
		);
	});

	it("names a parked issue's park over its wait and its place in the launch set, below its exclusion (#2722)", () => {
		expect(whyNotLaunched(snapshot, 8)).toBe(
			`parked — an away-mode refill loop skips it; a normal-mode one resumes it ahead of new work, oldest park first (pick-next, ${AT})`,
		);
		expect(whyNotLaunched(snapshot, 7)).toBe(
			`parked — an away-mode refill loop skips it; a normal-mode one resumes it ahead of new work, oldest park first (pick-next, ${AT})`,
		);
	});

	it("says nothing where the run does not list the issue, or there is no run", () => {
		expect(whyNotLaunched(snapshot, 6)).toBeNull();
		expect(whyNotLaunched(null, 1)).toBeNull();
	});
});

describe("readSnapshot (#2693)", () => {
	const root = () => path.join(sb.dir, "checkout");
	const write = (text: string) => {
		fs.mkdirSync(path.dirname(snapshotFile(root())), { recursive: true });
		fs.writeFileSync(snapshotFile(root()), text);
	};

	it("reads the checkout's own run, whose repo is pick-next's placeholder", () => {
		write(JSON.stringify(snapshot));
		expect(readSnapshot(root(), "acme/a")).toEqual({ snapshot, why: null });
	});

	it("drops a run made with --repo against another tracker", () => {
		write(
			JSON.stringify({
				...snapshot,
				repo: "acme/b",
				argv: ["--repo", "acme/b"],
			}),
		);
		expect(readSnapshot(root(), "acme/a")).toEqual({
			snapshot: null,
			why: null,
		});
	});

	it("is silent where no run has been, and says why where the file will not parse", () => {
		fs.rmSync(snapshotFile(root()), { force: true });
		expect(readSnapshot(root(), "acme/a")).toEqual({
			snapshot: null,
			why: null,
		});
		write("{torn");
		const read = readSnapshot(root(), "acme/a");
		expect(read.snapshot).toBeNull();
		expect(read.why).toMatch(/JSON/);
	});
});
