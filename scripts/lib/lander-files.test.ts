// @vitest-environment node

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const { beatingBefore, fileLedger, heartbeatWriter, readHeartbeat } =
	createRequire(__filename)("./lander-files.js");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lander-files-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

it("reads a missing ledger as holding no sha", () => {
	const ledger = fileLedger(path.join(dir, "ledger"));
	expect(ledger.readShas()).toEqual([]);
	expect(ledger.has("abc")).toBe(false);
	expect(ledger.greenAt("abc")).toBeNull();
	ledger.remove("abc");
	ledger.add("abc");
	expect(ledger.readShas()).toEqual(["abc"]);
});

it("throws on a ledger that will not read, naming the fault", () => {
	const file = path.join(dir, "ledger");
	fs.mkdirSync(file);
	const ledger = fileLedger(file);
	for (const read of [
		() => ledger.readShas(),
		() => ledger.has("abc"),
		() => ledger.greenAt("abc"),
		() => ledger.remove("abc"),
	])
		expect(read).toThrow(/EISDIR/);
});

it("keeps the batch last named on a heartbeat that names none (#5360)", () => {
	const file = path.join(dir, "heartbeat");
	const beat = heartbeatWriter(file);
	beat("tip");
	beat();
	expect(readHeartbeat(file).batch).toBe("tip");
	beat(null);
	beat();
	expect(readHeartbeat(file).batch).toBeNull();
});

it("beats before each call through its deps, passing each call's arguments and result through (#5644)", () => {
	const order: string[] = [];
	const deps = beatingBefore(() => order.push("beat"), {
		read: (n: number) => {
			order.push(`read ${n}`);
			return n * 2;
		},
		label: "kept",
	});
	expect(deps.read(2)).toBe(4);
	expect(deps.read(3)).toBe(6);
	expect(deps.label).toBe("kept");
	expect(order).toEqual(["beat", "read 2", "beat", "read 3"]);
});
