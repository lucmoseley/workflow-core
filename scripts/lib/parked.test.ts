// @vitest-environment node
/*
 * The park marker's limit-cap count (#3804), through its real file, as the marker
 * is the one record that outlives a launch. A count that does not read back
 * lets a ticket burn the cap without bound; one that survives another write
 * holds back a question waiting on the founder.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readParkMarkers, writeParkedBy } from "./parked.js";

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
