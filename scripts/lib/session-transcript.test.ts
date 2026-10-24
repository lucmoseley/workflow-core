// @vitest-environment node
/*
 * The tail read drops the line its offset cut rather than handing on a
 * fragment (mantahostels#3311), asserted on a file big enough to trigger it.
 * `guard-lost-deny.js` and `guard-inventory.js` read through it as Stop hooks
 * in `.claude/settings.json`; loosen a case and every Stop of an oversize
 * session reports a corrupt transcript that is not. `resolve` is not
 * covered here: it reaches for every config dir on the machine, which a test
 * cannot stand up without writing outside its own tmpdir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mainChainRecords } from "./transcript";

const { read } = require("./session-transcript");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-transcript-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A transcript of `n` identical records, each padded to `pad` bytes. */
const write = (n: number, pad: number) => {
	const file = path.join(dir, "t.jsonl");
	const line = (i: number) =>
		`${JSON.stringify({ type: "user", uuid: `u${i}`, filler: "x".repeat(pad) })}\n`;
	const fd = fs.openSync(file, "w");
	for (let i = 0; i < n; i++) fs.writeSync(fd, line(i));
	fs.closeSync(fd);
	return file;
};

describe("read", () => {
	it("returns a small transcript whole", () => {
		const file = write(3, 10);
		expect(read(file)).toBe(fs.readFileSync(file, "utf8"));
	});

	it("drops the line the tail offset cut, rather than handing on a fragment — mantahostels#3311", () => {
		/* 20 MB of records, over the 16 MB whole-file limit, so the 8 MB tail
		 * offset lands mid-line. */
		const file = write(2000, 10 * 1024);
		const text = read(file);

		expect(text.length).toBeLessThan(fs.statSync(file).size);
		expect(() => JSON.parse(text.split("\n")[0])).not.toThrow();
		const stats = { skipped: 0 };
		expect([...mainChainRecords(text, "main")].length).toBeGreaterThan(0);
		mainChainRecords(text, "main", stats).next();
		expect(stats.skipped).toBe(0);
	});
});
