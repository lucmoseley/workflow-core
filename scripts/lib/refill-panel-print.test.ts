// @vitest-environment node
/*
 * The panel's print (#4114): the screen read off a frame, and which running panels it
 * sizes itself by. Broken, a session checking what the founder reads sees another
 * screen than the pane shows, and hands him the check again.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeProcRoot } from "./proc-fake";
import { buildFrame } from "./refill-panel.js";
import { buildScreenLines, findPanelSizes } from "./refill-panel-print.js";

const ESC = "\u001b";

describe("buildScreenLines", () => {
	it("places text where the cursor moves, styling dropped", () => {
		const frame = `${ESC}[2;3H${ESC}[1m${ESC}[38;2;1;2;3mHi${ESC}[0m${ESC}[K${ESC}[4;1Hthere`;
		expect(buildScreenLines(frame, 5)).toEqual(["", "  Hi", "", "there"]);
	});

	it("erases to the line's end and below the cursor", () => {
		const frame = `${ESC}[1;1Habcdef${ESC}[2;1Hzzz${ESC}[1;3H${ESC}[K`;
		expect(buildScreenLines(frame, 3)).toEqual(["ab", "zzz"]);
		expect(buildScreenLines(`${frame}${ESC}[J`, 3)).toEqual(["ab"]);
	});

	it("skips an image to its terminator", () => {
		const frame = `${ESC}[1;1Hab${ESC}Pq#0;2;0;0;0~~${ESC}\\cd`;
		expect(buildScreenLines(frame, 1)).toEqual(["abcd"]);
	});

	it("shows a frame's rows as the pane would, cut at its margin-less width", () => {
		const rows = [
			{ text: "Refill loop  [on]", role: "name", pointed: true },
			{ text: "a row far longer than the pane is wide", role: "secondary" },
		];
		// biome-ignore lint/suspicious/noExplicitAny: a Row's other fields are optional
		const lines = buildScreenLines(buildFrame(rows as any, 20, 10), 10);
		expect(lines).toEqual(["", "❯ Refill loop  [o…", "  a row far longe…"]);
	});
});

describe("findPanelSizes", () => {
	let fake: ReturnType<typeof makeProcRoot>;
	afterEach(() => fake.remove());

	/** A process whose stdout is `tty`. */
	const withTty = (pid: number, argv: string, tty: string) => {
		fake.proc(pid, { argv });
		fs.mkdirSync(path.join(fake.root, String(pid), "fd"));
		fs.symlinkSync(tty, path.join(fake.root, String(pid), "fd", "1"));
	};

	it("sizes each running panel by its terminal, leaving out prints and other scripts", () => {
		fake = makeProcRoot();
		withTty(
			30,
			"node /x/scripts/refill-panel.js 12 windows-terminal",
			"/dev/pts/5",
		);
		withTty(20, "node /x/scripts/refill-panel.js 13", "/dev/pts/7");
		withTty(40, "node /x/scripts/refill-panel.js --print", "/dev/pts/9");
		withTty(50, "node /x/scripts/refill-loop.js watch", "/dev/pts/9");
		const sizes: Record<string, string> = {
			"/dev/pts/5": "50 38\n",
			"/dev/pts/7": "24 80\n",
		};
		expect(
			findPanelSizes({
				root: fake.root,
				readSize: (tty) => sizes[tty] ?? "",
			}),
		).toEqual([
			{ pid: 20, tty: "/dev/pts/7", rows: 24, columns: 80 },
			{ pid: 30, tty: "/dev/pts/5", rows: 50, columns: 38 },
		]);
	});

	it("leaves out a panel whose terminal will not read", () => {
		fake = makeProcRoot();
		withTty(30, "node /x/scripts/refill-panel.js 12", "/dev/pts/5");
		fake.proc(31, { argv: "node /x/scripts/refill-panel.js 14" });
		expect(
			findPanelSizes({
				root: fake.root,
				readSize: () => {
					throw new Error("stty: /dev/pts/5: No such file");
				},
			}),
		).toEqual([]);
	});
});
