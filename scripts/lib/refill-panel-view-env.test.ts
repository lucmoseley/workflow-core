// @vitest-environment node
/*
 * The view's environment (#3886). Broken, a loop the panel restarts finds no `claude`
 * and launches nothing, in a pane that looks fine. The width (#3956) sizes the split.
 */
import { describe, expect, it } from "vitest";
import { readViewColumns, readViewEnv } from "./refill-panel-view-env.js";

describe("readViewColumns", () => {
	const onPts = () => "/dev/pts/4";

	it("reads the width off the terminal the view draws on", () => {
		const seen: string[] = [];
		const columns = readViewColumns(
			42,
			(file) => {
				seen.push(file);
				return "/dev/pts/4";
			},
			(tty) => {
				seen.push(tty);
				return "50 108\n";
			},
		);
		expect(columns).toBe(108);
		expect(seen).toEqual(["/proc/42/fd/1", "/dev/pts/4"]);
	});

	it.each([
		["no terminal", () => "/dev/null", () => "50 108\n"],
		["a size of nought", onPts, () => "0 0\n"],
		["no output from stty", onPts, () => ""],
	])("is null with %s", (_, readLink, readSize) => {
		expect(readViewColumns(42, readLink, readSize)).toBeNull();
	});

	it("is null where the process has gone", () => {
		const gone = () => {
			throw new Error("ENOENT");
		};
		expect(readViewColumns(42, gone)).toBeNull();
	});
});

describe("readViewEnv", () => {
	it("splits the kernel's NUL-separated entries, keeping an = in a value", () => {
		const read = () => "A=1\0B=x=y\0EMPTY=\0";
		expect(readViewEnv(42, read)).toEqual({ A: "1", B: "x=y", EMPTY: "" });
	});

	it("reads the given pid's file", () => {
		const seen: string[] = [];
		readViewEnv(42, (file) => {
			seen.push(file);
			return "";
		});
		expect(seen).toEqual(["/proc/42/environ"]);
	});

	it("is empty where the file cannot be read", () => {
		const read = () => {
			throw new Error("ENOENT");
		};
		expect(readViewEnv(42, read)).toEqual({});
	});

	it("reads a real process", () => {
		expect(readViewEnv(process.pid).PATH).toBeTruthy();
	});
});
