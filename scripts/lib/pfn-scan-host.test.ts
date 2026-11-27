// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { earlierFlagged } from "./pfn-scan-host.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pfn-scan-host-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("earlierFlagged", () => {
	it("reads the PFNs other scans beside the dump flagged, skipping its own and a torn one", () => {
		const dump = path.join(dir, "live-261129-0700.dmp");
		fs.writeFileSync(
			path.join(dir, "live-261128-0700.dmp.pfnscan.json"),
			JSON.stringify({ flagged: [{ pfn: "0x953de" }] }),
		);
		fs.writeFileSync(
			`${dump}.pfnscan.json`,
			JSON.stringify({ flagged: [{ pfn: "0x1" }] }),
		);
		fs.writeFileSync(path.join(dir, "live-261127-0700.dmp.pfnscan.json"), "{");
		expect([...earlierFlagged(dump)]).toEqual(["0x953de"]);
	});
});
