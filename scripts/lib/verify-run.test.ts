// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { runVerify } from "./verify-run.js";

let cwd: string;

beforeEach(() => {
	cwd = process.cwd();
});

describe("runVerify (#305)", () => {
	it("reports ok on a passing command", () => {
		expect(runVerify("true", { cwd }).ok).toBe(true);
	});

	it("reports a non-zero exit with the command's output, not a timeout", () => {
		const result = runVerify("echo said this >&2; exit 3", { cwd });
		expect(result).toMatchObject({
			ok: false,
			status: 3,
			timedOut: false,
			suffix: "",
		});
		expect(result.ok === false && result.said).toMatch(/said this/);
	});

	it("carries a failure written only to stdout (#1268)", () => {
		const result = runVerify("echo the-reason; exit 1", { cwd });
		expect(result.ok === false && result.said).toBe("the-reason");
	});

	it("carries both streams, stdout first, when each has output", () => {
		const result = runVerify("echo out; echo err >&2; exit 1", { cwd });
		expect(result.ok === false && result.said).toBe("out\nerr");
	});

	it("keeps only the tail of a long stream, saying how much it cut", () => {
		const result = runVerify("seq 1 100; exit 1", { cwd });
		const said = result.ok === false ? result.said.split("\n") : [];
		expect(said[0]).toBe("… 20 earlier lines cut");
		expect(said.slice(1)).toEqual(
			Array.from({ length: 80 }, (_, i) => String(i + 21)),
		);
	});

	it("marks a real timeout kill timedOut", () => {
		const result = runVerify("sleep 5", { cwd, timeout: 150 });
		expect(result).toMatchObject({
			ok: false,
			timedOut: true,
			suffix: " — killed after exceeding 150ms",
		});
	});

	it("does not call a manual signal kill a timeout", () => {
		const result = runVerify("kill -TERM $$", { cwd, timeout: 5000 });
		expect(result).toMatchObject({ ok: false, timedOut: false, suffix: "" });
	});
});
