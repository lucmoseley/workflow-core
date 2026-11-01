// @vitest-environment node
/*
 * lib/read-hidden.js reads one line with echo off (#640). A fake terminal
 * stands in for the real one, to control how input splits across reads;
 * `test_write_secret_tty.py` drives the same read through a real pty.
 *
 * `write-secret.js` reads a founder's credential through it in a hand-over;
 * loosen a case and a stray escape byte or dropped key alters the stored secret, a
 * Ctrl-C writes a half-typed one to `.env`, or the rest of a pasted key reaches
 * the shell and its history, or the tail of one typed after a bad byte does.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHidden, SETTLE_MS } from "./read-hidden.js";

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

/** A read on a fake terminal, given `chunks`. */
const reading = (...chunks: (string | Buffer)[]) => {
	const input = fakeTty();
	// @ts-expect-error — the fake carries only what readHidden calls
	const line: Promise<string> = readHidden(input);
	for (const chunk of chunks) input.emit("data", chunk);
	return { input, line };
};

/** What the read came to once the terminal settles, as the value or the reason. */
const settled = async (line: Promise<string>) => {
	const outcome = line.catch((e: Error) => `rejected: ${e.message}`);
	await vi.runAllTimersAsync();
	return outcome;
};

describe("readHidden", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("collects typed and pasted chunks to Enter, applying backspace and dropping whole escape sequences", async () => {
		const { input, line } = reading(
			Buffer.from("abx\x7f"),
			"c\x1b[D\x1bOA\x1b[1;5Cd\r",
		);
		expect(input.raw).toEqual([true]);
		expect(await settled(line)).toBe("abcd");
		expect(input.raw).toEqual([true, false]);
		expect(input.listenerCount("data")).toBe(0);
	});

	it("rejects on Ctrl-C and leaves raw mode", async () => {
		const { input, line } = reading("abc\x03");
		expect(await settled(line)).toContain("interrupted");
		expect(input.raw).toEqual([true, false]);
	});

	it("keeps a multibyte character split across two reads whole (#3675)", async () => {
		const e = Buffer.from("é");
		const { line } = reading(
			Buffer.concat([Buffer.from("caf"), e.subarray(0, 1)]),
			Buffer.concat([e.subarray(1), Buffer.from("\r")]),
		);
		expect(await settled(line)).toBe("café");
	});

	it.each([
		["Enter", "\r"],
		["a line feed", "\n"],
		["Ctrl-C", "\x03"],
		["Ctrl-D", "\x04"],
	])(
		"holds raw mode after an invalid byte, whatever the pause, discarding input until %s rejects it as not UTF-8 (#3826)",
		async (_l, end) => {
			const { input, line } = reading(Buffer.from([0x53, 0xff]));
			await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
			input.emit("data", Buffer.from("RET-TAIL é\x7f\x1b[D"));
			await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
			expect(input.raw).toEqual([true]);
			expect(input.listenerCount("data")).toBe(1);

			input.emit("data", end);
			expect(await settled(line)).toContain("not valid UTF-8");
			expect(input.raw).toEqual([true, false]);
		},
	);

	it("rejects bytes that are not UTF-8 rather than storing U+FFFD, and leaves raw mode (#3675)", async () => {
		const { input, line } = reading(Buffer.from([0x61, 0xe9, 0x0d]));
		expect(await settled(line)).toContain("not valid UTF-8");
		expect(input.raw).toEqual([true, false]);
		expect(input.listenerCount("data")).toBe(0);
	});

	it("backspaces over an astral character whole, leaving no lone surrogate (#3675)", async () => {
		const { line } = reading(Buffer.from("a😀\x7f\r"));
		expect(await settled(line)).toBe("a");
	});

	it.each([
		["a CRLF in one read", ["key\r\n"]],
		["a CRLF across two reads", ["key\r", "\n"]],
		["a lone LF", ["key\n"]],
	])("reads %s as the one line end (#3817)", async (_l, chunks) => {
		expect(await settled(reading(...chunks).line)).toBe("key");
	});

	it.each([
		["in the same read", ["-----BEGIN KEY-----\rMIIE"]],
		["in a later read", ["-----BEGIN KEY-----\r", "MIIE\r"]],
		["after a CRLF", ["key\r\nMIIE"]],
		["as a second line end", ["key\n\n"]],
		["as a second CRLF's CR", ["key\r", "\r\n"]],
		["as the start of a character", [Buffer.from([0x61, 0x0d, 0xc3])]],
	])("rejects input following the line end %s (#3817)", async (_l, chunks) => {
		const { input, line } = reading(...chunks);
		expect(await settled(line)).toContain("more input followed the line end");
		expect(input.raw).toEqual([true, false]);
		expect(input.listenerCount("data")).toBe(0);
	});

	it("stays in raw mode, reading, until the terminal has been silent for the whole window (#3817)", async () => {
		const { input, line } = reading("key\r");
		await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
		input.emit("data", "more");
		await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
		expect(input.raw).toEqual([true]);
		expect(input.listenerCount("data")).toBe(1);
		expect(await settled(line)).toContain("more input followed");
	});

	it.each([
		["Ctrl-C", "interrupted", "abc\x03rest"],
		["bytes not UTF-8", "not valid UTF-8", Buffer.from([0xe9, 0x0d])],
		["Ctrl-D", "Ctrl-D ended the input", "abc\x04rest"],
	])(
		"keeps reading after %s until the terminal settles (#3817)",
		async (_l, why, first) => {
			const { input, line } = reading(first);
			expect(input.listenerCount("data")).toBe(1);
			expect(input.raw).toEqual([true]);
			input.emit("data", "more\r");
			expect(await settled(line)).toContain(why);
			expect(input.raw).toEqual([true, false]);
		},
	);

	it.each([
		["a tab", "a\tb\r"],
		["a tab a backspace followed", "a\t\x7fb\r"],
		["a tab after ESC", "a\x1b\tb\r"],
		["a tab inside a sequence", "a\x1b[\tAb\r"],
		["Ctrl-U", "wrong\x15right\r"],
		["a NUL", "a\0b\r"],
		["ESC before a character", "\x1bsk-test\r"],
		["ESC ESC", "abc\x1b\x1b[Dd\r"],
		["an OSC sequence", "a\x1b]0;title\x07b\r"],
		["an escape open at the line end", "abc\x1b\r"],
		["a CSI open at the line end", "abc\x1b[\r"],
	])(
		"rejects %s at the line end, not the key, and never drops it (#3817)",
		async (_l, typed) => {
			const { input, line } = reading(typed.slice(0, -1));
			expect(input.raw).toEqual([true]);
			expect(input.listenerCount("data")).toBe(1);
			input.emit("data", "\r");
			expect(await settled(line)).toContain("a tab, a control key or a broken");
		},
	);

	it("ends the line at a CR inside an open escape, rather than swallowing it (#3817)", async () => {
		const { line } = reading("line1\x1b\rline2\r");
		expect(await settled(line)).toContain("a tab, a control key or a broken");
	});

	it("rejects Ctrl-C inside an open escape, rather than swallowing it (#3817)", async () => {
		const { line } = reading("abc\x1b\x03def\r");
		expect(await settled(line)).toContain("interrupted");
	});

	it.each([
		["end", undefined],
		["error", new Error("read EIO")],
	])(
		"rejects at once when the terminal closes with an '%s' before the line ends (#3817)",
		async (event, arg) => {
			const { input, line } = reading("partial");
			input.emit(event, arg);
			expect(input.raw).toEqual([true, false]);
			expect(await settled(line)).toContain("the terminal closed");
			expect(() =>
				input.emit("error", new Error("setRawMode EBADF")),
			).not.toThrow();
		},
	);

	it("rejects a line already ended when the terminal closes while settling (#3817)", async () => {
		const { input, line } = reading("key\r");
		input.emit("end");
		expect(await settled(line)).toContain("the terminal closed");
	});
});
