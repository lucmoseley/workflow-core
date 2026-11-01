// @vitest-environment node
/*
 * The park marker's limit-cap count (#3804), through its real file, as the marker
 * is the one record that outlives a launch. A count that does not read back
 * lets a ticket burn the cap without bound; one that survives another write
 * holds back a question waiting on the founder. A marker that will not read
 * (#3893) must not read as no hold on the idle alarm, which would hide a
 * limit-cap hold, nor blank the loop's other markers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	listParkMarkers,
	readParkedBy,
	readParkMarkers,
	writeParkedBy,
} from "./parked.js";

let root: string;

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

describe("a marker that will not read (#3893)", () => {
	const markerFile = (sessionId: string) =>
		path.join(root, ".claude", "tmp", "markers", `.parked-${sessionId}`);

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
			expect(() => listParkMarkers(root)).toThrow(/EACCES/);
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
		expect(listParkMarkers(root)).toMatchObject([
			{ sessionId: "s1", issues: [7] },
		]);
	});
});
