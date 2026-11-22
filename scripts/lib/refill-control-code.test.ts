// @vitest-environment node
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProcRoot, writeCwd } from "./proc-fake";
import { readRunningProgram } from "./refill-control-code.js";

const PID = 4242;
const ARGV = "node scripts/refill-loop.js run";

let fake: ReturnType<typeof makeProcRoot>;

beforeEach(() => {
	fake = makeProcRoot();
	vi.stubEnv("WFC_PROC", fake.root);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fake.remove();
});

describe("readRunningProgram (#5571)", () => {
	it("resolves the loop program against the process's cwd", () => {
		fake.proc(PID, { argv: ARGV });
		writeCwd(fake.root, String(PID), fake.root);
		expect(readRunningProgram(PID)).toEqual({
			program: path.join(fake.root, "scripts/refill-loop.js"),
		});
	});

	it("names the command line that runs no loop program", () => {
		fake.proc(PID, { argv: "node other.js" });
		expect(readRunningProgram(PID)).toEqual({
			unread: `pid ${PID} runs no refill-loop.js: "node other.js"`,
		});
	});

	it("says a pid with no /proc entry is gone", () => {
		expect(readRunningProgram(PID)).toEqual({ unread: `pid ${PID} is gone` });
	});
});
