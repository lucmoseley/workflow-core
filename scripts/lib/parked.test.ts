// @vitest-environment node
/*
 * The park marker's limit-cap count (#3804), through its real file, as the marker
 * is the one record that outlives a launch. A count that does not read back
 * lets a ticket burn the cap without bound; one that survives another write
 * holds back a question waiting on the founder. A marker that will not read
 * (#3893) must not read as no hold on the idle alarm, which would hide a
 * limit-cap hold, nor blank the loop's other markers. unparkClosed (#3940) reports
 * a label that stays, for the next tick to retry, and throws on an unread list.
 * moveParkedBy (#3709, #3940) writes the copy's marker before trimming the old
 * one: the other order loses the park on a failed write, so no typing or ending
 * takes the label off. A key that does not read back (#4147) reads an overflow
 * seat's session as the plan seat's on its dir, and charges that seat's cap.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { printed, stubGhRoutes } from "./gh-stub";
import {
	moveParkedBy,
	readParkedBy,
	readParkMarkers,
	readParkMarkersOrThrow,
	unparkClosed,
	writeParkedBy,
} from "./parked.js";

let root: string;

const markerFile = (sessionId: string) =>
	path.join(root, ".claude", "tmp", "markers", `.parked-${sessionId}`);

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "parked-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("a park marker's limit-cap count (#3804)", () => {
	const job = { seat: "/s", jobId: "j", cwd: "/c" };

	it("reads back the count a limit-cap park wrote, its issues and job intact", () => {
		writeParkedBy("s1", [7], { root, job, limitParks: 2 });
		expect(readParkMarkers(root)).toMatchObject([
			{ sessionId: "s1", issues: [7], job, limitParks: 2 },
		]);
	});

	it("drops it on a write that carries none, keeping the job", () => {
		writeParkedBy("s1", [7], { root, job, limitParks: 2 });
		writeParkedBy("s1", [7], { root });
		const [marker] = readParkMarkers(root);
		expect(marker?.job).toEqual(job);
		expect(marker).not.toHaveProperty("limitParks");
	});
});

describe("a park marker's cause (#3949)", () => {
	const job = { seat: "/s", jobId: "j", cwd: "/c" };

	it("reads back the block the loop stopped it on", () => {
		writeParkedBy("s1", [7], { root, job, cause: "PERMISSION" });
		expect(readParkMarkers(root)).toMatchObject([
			{ issues: [7], job, cause: "PERMISSION" },
		]);
	});

	it("drops it on a write that carries none", () => {
		writeParkedBy("s1", [7], { root, job, cause: "LIMIT" });
		writeParkedBy("s1", [7], { root });
		expect(readParkMarkers(root)[0]).not.toHaveProperty("cause");
	});
});

describe("a park marker's overflow key (#4147)", () => {
	const job = { seat: "/s2", jobId: "j1", cwd: null };

	it("reads back the key it was written with, and keeps it through a write naming no job", () => {
		writeParkedBy("s-key", [7], { root, job: { ...job, keyVar: "K2" } });
		expect(readParkMarkers(root)[0].job).toEqual({ ...job, keyVar: "K2" });
		writeParkedBy("s-key", [7, 8], { root });
		expect(readParkMarkers(root)[0].job).toEqual({ ...job, keyVar: "K2" });
	});

	it("reads a marker written before keys as a plan seat's: no key on its job", () => {
		fs.mkdirSync(path.dirname(markerFile("s-old")), { recursive: true });
		fs.writeFileSync(markerFile("s-old"), "seat /s2\njob j1\n7\n");
		expect(readParkMarkers(root)[0].job).toEqual(job);
	});
});

describe("a marker that will not read (#3893)", () => {
	/** Unlocked after `body`, so the tmp dir cleans up. */
	function withLockedMarker(body: () => void) {
		writeParkedBy("s1", [7], { root });
		writeParkedBy("s2", [8], { root });
		fs.chmodSync(markerFile("s2"), 0o000);
		try {
			body();
		} finally {
			fs.chmodSync(markerFile("s2"), 0o600);
		}
	}

	it("throws from the alarm's listing", () => {
		withLockedMarker(() => {
			expect(() => readParkMarkersOrThrow(root)).toThrow(/EACCES/);
		});
	});

	it("is left out of the loop's read, the other markers kept", () => {
		withLockedMarker(() => {
			expect(readParkMarkers(root)).toMatchObject([
				{ sessionId: "s1", issues: [7] },
			]);
		});
	});

	it("reads as no issues for its session", () => {
		withLockedMarker(() => {
			expect(readParkedBy("s2", root)).toEqual([]);
		});
	});

	it("counts a marker gone between the listing and its read as no park (#3709)", () => {
		writeParkedBy("s1", [7], { root });
		/* Listed by readdir, gone to stat and read: the race, held still. */
		fs.symlinkSync(path.join(root, "gone"), markerFile("s2"));
		expect(readParkMarkersOrThrow(root)).toMatchObject([
			{ sessionId: "s1", issues: [7] },
		]);
	});
});

describe("moveParkedBy (#3709, #3940)", () => {
	const job = { seat: "/s", jobId: "copy-job", cwd: "/c" };
	const move = (issues: number[], copySessionId: string | null) =>
		moveParkedBy("old", issues, { root, copySessionId, job });

	it("moves the listed issues to the copy's marker, under its job, leaving the rest", () => {
		writeParkedBy("old", [5, 6], { root });
		writeParkedBy("copy", [9], { root });
		move([5, 7], "copy");
		expect(readParkedBy("old", root)).toEqual([6]);
		expect(readParkMarkers(root)).toContainEqual(
			expect.objectContaining({ sessionId: "copy", issues: [9, 5], job }),
		);
	});

	it("writes no marker where the old one lists none of them", () => {
		writeParkedBy("old", [6], { root });
		move([5], "copy");
		expect(readParkedBy("old", root)).toEqual([6]);
		expect(readParkMarkers(root).map((m) => m.sessionId)).toEqual(["old"]);
	});

	it("leaves them on neither where the copy's session id went unread", () => {
		writeParkedBy("old", [5], { root });
		move([5], null);
		expect(readParkMarkers(root)).toEqual([]);
	});

	it("keeps them on the old marker where the copy's will not write", () => {
		writeParkedBy("old", [5], { root });
		fs.mkdirSync(markerFile("copy"));
		expect(() => move([5], "copy")).toThrow();
		expect(readParkedBy("old", root)).toEqual([5]);
	});
});

describe("unparkClosed (#3940)", () => {
	const ListRoute = "issue list --repo o/r --state closed --label parked *";
	const fail = { status: 1, stdout: "", stderr: "HTTP 502\n" };

	const withGh = (routes: Parameters<typeof stubGhRoutes>[1]) => {
		const was = process.env.WFC_GH;
		process.env.WFC_GH = stubGhRoutes(root, routes).gh;
		try {
			return unparkClosed("o/r");
		} finally {
			if (was === undefined) delete process.env.WFC_GH;
			else process.env.WFC_GH = was;
		}
	};

	it("clears each closed issue, reporting one the label would not leave", () => {
		const { cleared, failed } = withGh({
			[ListRoute]: printed('[{"number":12},{"number":13}]'),
			"issue edit 12 *": printed(),
			"issue edit 13 *": fail,
		});
		expect(cleared).toEqual([12]);
		expect(failed).toMatchObject([{ n: 13 }]);
	});

	it("throws where the list will not read", () => {
		expect(() => withGh({ [ListRoute]: fail })).toThrow();
	});
});
