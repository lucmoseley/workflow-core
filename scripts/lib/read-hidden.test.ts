// @vitest-environment node
/*
 * lib/read-hidden.js reads one line with echo off (#640). A fake terminal
 * stands in for the real one, whose raw mode no test process can hold.
 *
 * `write-secret.js` reads a founder's credential through it in a hand-over;
 * loosen a case and a stray escape byte lands inside the stored secret, or a
 * Ctrl-C writes a half-typed one to `.env`.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { readHidden } from "./read-hidden.js";

const fakeTty = () =>
	Object.assign(new EventEmitter(), {
		raw: [] as boolean[],
		setRawMode(on: boolean) {
			this.raw.push(on);
			return this;
		},
		pause() {
			return this;
		},
		resume() {
			return this;
		},
	});

describe("readHidden", () => {
	it("collects typed and pasted chunks to Enter, applying backspace and dropping whole escape sequences, in raw mode throughout", async () => {
		const input = fakeTty();
		// @ts-expect-error — the fake carries only what readHidden calls
		const line = readHidden(input);
		input.emit("data", Buffer.from("abx\x7f"));
		input.emit("data", "c\x1b[D\x1bOAd\rignored");
		await expect(line).resolves.toBe("abcd");
		expect(input.raw).toEqual([true, false]);
		expect(input.listenerCount("data")).toBe(0);
	});

	it("rejects on Ctrl-C and leaves raw mode", async () => {
		const input = fakeTty();
		// @ts-expect-error — the fake carries only what readHidden calls
		const line = readHidden(input);
		input.emit("data", "abc\x03");
		await expect(line).rejects.toThrow("interrupted");
		expect(input.raw).toEqual([true, false]);
	});

	it("keeps a multibyte character split across two reads whole (#3675)", async () => {
		const input = fakeTty();
		// @ts-expect-error — the fake carries only what readHidden calls
		const line = readHidden(input);
		const e = Buffer.from("é");
		input.emit("data", Buffer.concat([Buffer.from("caf"), e.subarray(0, 1)]));
		input.emit("data", Buffer.concat([e.subarray(1), Buffer.from("\r")]));
		await expect(line).resolves.toBe("café");
	});

	it("rejects bytes that are not UTF-8 rather than storing U+FFFD, and leaves raw mode (#3675)", async () => {
		const input = fakeTty();
		// @ts-expect-error — the fake carries only what readHidden calls
		const line = readHidden(input);
		input.emit("data", Buffer.from([0x61, 0xe9, 0x0d]));
		await expect(line).rejects.toThrow("not UTF-8");
		expect(input.raw).toEqual([true, false]);
		expect(input.listenerCount("data")).toBe(0);
	});

	it("backspaces over an astral character whole, leaving no lone surrogate (#3675)", async () => {
		const input = fakeTty();
		// @ts-expect-error — the fake carries only what readHidden calls
		const line = readHidden(input);
		input.emit("data", Buffer.from("a😀\x7f\r"));
		await expect(line).resolves.toBe("a");
	});
});
