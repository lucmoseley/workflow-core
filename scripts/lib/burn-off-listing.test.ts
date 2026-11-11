// @vitest-environment node
/*
 * lib/burn-off-listing.js lists every plan's live background sessions with
 * the model each last answered on, for scripts/burn-off-sessions.js (#4992).
 * A red here means `burn-mode.sh off` would leave a Fable session running, or
 * move one it should not, or read a plan it could not list as empty.
 */
import { describe, expect, it } from "vitest";
import { readLiveSessions } from "./burn-off-listing.js";

const plans = () => ["/h/.claude", "/h/.claude2"];

describe("readLiveSessions", () => {
	it("takes live background sessions alone, a finished one left out, each with its seat and model", () => {
		const r = readLiveSessions("/h", {
			plans,
			read: (seat) =>
				seat === "/h/.claude2"
					? {
							agents: [
								{ kind: "background", sessionId: "a", cwd: "/w", name: "A" },
								{ kind: "interactive", sessionId: "b", cwd: "/w" },
								{
									kind: "background",
									sessionId: "c",
									cwd: "/w",
									state: "done",
								},
							],
						}
					: { agents: [] },
			modelOf: (_seat, id) => (id === "a" ? "claude-fable-5-2" : ""),
		});
		expect(r).toEqual({
			sessions: [
				{
					seat: "/h/.claude2",
					sessionId: "a",
					cwd: "/w",
					name: "A",
					model: "claude-fable-5-2",
				},
			],
			faults: [],
		});
	});

	it("names a plan whose listing will not read, and reads the rest", () => {
		const r = readLiveSessions("/h", {
			plans,
			read: (seat) => {
				if (seat === "/h/.claude") throw new Error("no daemon");
				return { why: "did not return JSON" };
			},
			modelOf: () => "",
		});
		expect(r.sessions).toEqual([]);
		expect(r.faults).toEqual([
			"/h/.claude: listing not read: no daemon",
			"/h/.claude2: did not return JSON",
		]);
	});
});
