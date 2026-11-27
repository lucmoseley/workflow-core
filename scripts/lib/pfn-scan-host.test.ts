// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDB, PDB_KEY, writeCdb } from "./cdb-fake";
import { earlierFlagged, scanDump } from "./pfn-scan-host.js";
import { writePowershell } from "./powershell-fake";
import { writeWslpath } from "./wslpath-fake";

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

describe("scanDump", () => {
	const scanWith = (cdb: { exit?: number; reads?: boolean }) => {
		const diag = path.join(dir, "diag");
		fs.mkdirSync(path.join(diag, "sym", PDB, PDB_KEY), { recursive: true });
		fs.writeFileSync(path.join(diag, "sym", PDB, PDB_KEY, PDB), "");
		vi.stubEnv("WFC_DIAG_DIR", diag);
		vi.stubEnv("WFC_WSLPATH", writeWslpath(path.join(dir, "bin")));
		vi.stubEnv("WFC_CDB", writeCdb(path.join(dir, "bin"), cdb));
		vi.stubEnv("WFC_POWERSHELL", writePowershell(path.join(dir, "bin")).bin);
		return () => scanDump(path.join(dir, "live.dmp"));
	};

	it("reads every entry the dump's RAM run holds, then clears its work directory", () => {
		expect(scanWith({})().read).toBe(BigInt(0x10));
		expect(fs.readdirSync(path.join(dir, "diag"))).toEqual(["sym"]);
	});

	it("throws on a non-zero cdb exit", () => {
		expect(scanWith({ exit: 3 })).toThrow(
			/^cdb exited \d+: The system cannot find the file specified\.$/,
		);
	});

	it("throws where the scan read no entry", () => {
		expect(scanWith({ reads: false })).toThrow(
			"no PFN entry could be read from the dump",
		);
	});
});
