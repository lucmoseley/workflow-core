// @vitest-environment node
/*
 * The view's environment (#3886). Broken, a loop the panel restarts finds no `claude`
 * and launches nothing, in a pane that looks fine.
 */
import { describe, expect, it } from "vitest";
import { readViewEnv } from "./refill-panel-view-env.js";

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
