// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProcRoot, writeCwd } from "./proc-fake";
import { readRunningProgram } from "./refill-control-code.js";

const PID = 4242;
const ARGV = "node scripts/refill-loop.js run";

let fake: ReturnType<typeof makeProcRoot>;
const cmdline = () => path.join(fake.root, String(PID), "cmdline");

function plantMidExec(state = "R") {
	fake.proc(PID, { argv: ARGV, state });
	writeCwd(fake.root, String(PID), fake.root);
	const args = fs.readFileSync(cmdline());
	fs.writeFileSync(cmdline(), "");
	return () => fs.writeFileSync(cmdline(), args);
}

beforeEach(() => {
	fake = makeProcRoot();
	vi.stubEnv("WFC_PROC", fake.root);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fake.remove();
});

describe("readRunningProgram (#5571)", () => {
	it("waits out the empty command line of a loop mid-exec", () => {
		const finishExec = plantMidExec();
		const pause = vi.fn(finishExec);
		expect(readRunningProgram(PID, { pause })).toEqual({
			program: path.join(fake.root, "scripts/refill-loop.js"),
		});
		expect(pause).toHaveBeenCalledTimes(1);
	});

	it("says a zombie has exited, without waiting", () => {
		plantMidExec("Z");
		const pause = vi.fn();
		expect(readRunningProgram(PID, { pause })).toEqual({
			unread: `pid ${PID} has exited`,
		});
		expect(pause).not.toHaveBeenCalled();
	});

	it("gives up on a command line that stays empty, and says so", () => {
		plantMidExec();
		expect(readRunningProgram(PID, { pause: () => undefined })).toEqual({
			unread: `pid ${PID}'s command line stayed empty for 1000 ms`,
		});
	});

	it("names the command line that runs no loop program", () => {
		fake.proc(PID, { argv: "node other.js" });
		expect(readRunningProgram(PID)).toEqual({
			unread: `pid ${PID} runs no refill-loop.js: node other.js`,
		});
	});

	it("says a pid with no /proc entry is gone", () => {
		expect(readRunningProgram(PID)).toEqual({ unread: `pid ${PID} is gone` });
	});
});
