// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNOPENED, writeCdb } from "./cdb-fake";
import { writePowershell } from "./powershell-fake";
import {
	itNamesItsRecorder,
	readRecording,
	type ToolAnswer,
} from "./windows-tool-recording";
import { writeWslpath } from "./wslpath-fake";

const scan = require("./pfn-scan.js") as {
	IDENTITY_COMMANDS: string[];
	LAYOUT_COMMANDS: string[];
	parseIdentity: (
		out: string,
	) => { pdb: string; key: string } | { why: string };
	parseLayout: (
		out: string,
	) => { entrySize: number; runs: unknown[] } | { why: string };
	chunks: (layout: object) => { address: bigint }[];
};
const { cdbFailure, spawnCdb } = require("./pfn-scan-host.js") as {
	cdbFailure: (a: Answer) => string;
	spawnCdb: (
		dump: string,
		symbolDir: string,
		commands: string[],
		work: string,
	) => Answer;
};
const { readSize } = require("./file-size.js") as {
	readSize: (file: string) => number | null;
};

interface Answer extends ToolAnswer {
	asked?: number;
	written?: number | null;
}
type Key = "identity" | "layout" | "read" | "unread" | "unopened";

const recorded = readRecording<Record<Key, Answer>>(
	path.join(__dirname, "..", "fixtures", "cdb.json"),
);

// guess, #5813: any short length shows a whole or a short write
const ASKED = 0x30;

const CASES: { key: Key; name: string; check: (a: Answer) => void }[] = [
	{
		key: "identity",
		name: "`!lmi nt` gives parseIdentity the kernel's PDB and its key",
		check(a) {
			expect(a.status).toBe(0);
			expect(scan.parseIdentity(a.stdout)).toEqual({
				pdb: expect.stringMatching(/\.pdb$/),
				key: expect.stringMatching(/^[0-9A-F]{33,}$/),
			});
		},
	},
	{
		key: "layout",
		name: "the layout commands give parseLayout an entry size and PFN runs to chunk",
		check(a) {
			expect(a.status).toBe(0);
			const layout = scan.parseLayout(a.stdout);
			if ("why" in layout) throw new Error(layout.why);
			expect(layout.entrySize).toBeGreaterThan(0);
			expect(scan.chunks(layout).length).toBeGreaterThan(0);
		},
	},
	{
		key: "read",
		name: "a .writemem of a readable range writes every byte asked",
		check(a) {
			expect(a.status).toBe(0);
			expect(a.written).toBe(a.asked);
		},
	},
	{
		key: "unread",
		name: "a .writemem of an unreadable range exits 0, leaving an empty file",
		check(a) {
			expect(a.status).toBe(0);
			expect(a.written).toBe(0);
		},
	},
	{
		key: "unopened",
		name: "a dump that cannot be opened exits 1, saying why on stdout's last line",
		check(a) {
			expect(a.status).toBe(1);
			expect(a.stdout).toMatch(/^Could not open dump file \[/m);
			expect(a.stderr).toBe("");
			expect(cdbFailure(a)).toBe(UNOPENED);
		},
	},
];

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-contract-"));
	const bin = path.join(dir, "bin");
	vi.stubEnv("WFC_WSLPATH", writeWslpath(bin));
	vi.stubEnv("WFC_POWERSHELL", writePowershell(bin).bin);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function fakeAnswer(key: Key): Answer {
	const cdb = (opts: Parameters<typeof writeCdb>[1], commands: string[]) => {
		vi.stubEnv("WFC_CDB", writeCdb(path.join(dir, "bin"), opts));
		return spawnCdb(path.join(dir, "live.dmp"), dir, commands, dir);
	};
	const writemem = (reads: boolean) => {
		const file = path.join(dir, "c0.bin");
		const a = cdb({ reads }, [
			`.writemem ${file} 0x1000 L?0x${ASKED.toString(16)}`,
			"q",
		]);
		return {
			...a,
			asked: ASKED,
			written: readSize(file),
		};
	};
	switch (key) {
		case "identity":
			return cdb({}, scan.IDENTITY_COMMANDS);
		case "layout":
			return cdb({}, scan.LAYOUT_COMMANDS);
		case "read":
			return writemem(true);
		case "unread":
			return writemem(false);
		case "unopened":
			return cdb({ exit: 3 }, scan.IDENTITY_COMMANDS);
	}
}

describe("the fake", () => {
	for (const c of CASES) it(c.name, () => c.check(fakeAnswer(c.key)));
});

describe("the recorded cdbARM64.exe, reached through powershell.exe", () => {
	itNamesItsRecorder(recorded, "cdb");
	for (const c of CASES) it(c.name, () => c.check(recorded.responses[c.key]));
});
