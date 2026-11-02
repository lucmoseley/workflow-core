// @vitest-environment node
/*
 * Which splits an environment offers (#3886), and what returns focus from each
 * (#3887). Asserted on the whole argv, as a
 * dropped word or a flag `wt.exe` swallows opens no panel and nothing says so.
 */
import { describe, expect, it } from "vitest";
import { buildFocusReturn, buildRoutes } from "./refill-panel-routes.js";

const COMMAND = ["/n/node", "/p/refill-panel.js", "42"];
const WINDOWS_TERMINAL = {
	name: "windows-terminal",
	file: "cmd.exe",
	args: [
		"/c",
		"wt.exe",
		"-w",
		"0",
		"split-pane",
		"-V",
		"--size",
		"0.3",
		"--title",
		"refill",
		"wsl.exe",
		"-e",
		...COMMAND,
		"windows-terminal",
	],
};
const TMUX = {
	name: "tmux",
	file: "tmux",
	args: ["split-window", "-h", "-d", "-l", "30%", ...COMMAND, "tmux"],
};

const routes = (
	env: Record<string, string>,
	onPath: readonly string[] = ["cmd.exe", "wt.exe"],
) =>
	buildRoutes({
		env,
		isOnPath: (name) => onPath.includes(name),
		node: "/n/node",
		panel: "/p/refill-panel.js",
		pid: 42,
	});

describe("buildRoutes", () => {
	it("offers Windows Terminal, then tmux, where both are there", () => {
		expect(routes({ WSL_INTEROP: "/run/x", TMUX: "/t" })).toEqual([
			WINDOWS_TERMINAL,
			TMUX,
		]);
	});

	it("skips Windows Terminal with no interop", () => {
		expect(routes({ TMUX: "/t" })).toEqual([TMUX]);
	});

	it.each([["wt.exe"], ["cmd.exe"]])(
		"skips Windows Terminal with only %s on the path",
		(only) => {
			expect(routes({ WSL_INTEROP: "/run/x" }, [only])).toEqual([]);
		},
	);

	it("names the view's tmux pane where it has one", () => {
		const [route] = routes({ TMUX: "/t", TMUX_PANE: "%3" });
		expect(route?.args.slice(0, 4)).toEqual(["split-window", "-t", "%3", "-h"]);
	});

	it("offers no split with neither", () => {
		expect(routes({})).toEqual([]);
	});
});

describe("buildFocusReturn", () => {
	const View = { PATH: "/view", TMUX_PANE: "%1" };
	const Own = { TMUX_PANE: "%2" };

	it("moves left in the Windows Terminal window in use, on the view's PATH", () => {
		expect(buildFocusReturn("windows-terminal", View, Own)).toEqual({
			file: "cmd.exe",
			args: ["/c", "wt.exe", "-w", "0", "move-focus", "left"],
			env: View,
		});
	});

	it("selects the pane left of the panel's own in tmux, not the view's", () => {
		expect(buildFocusReturn("tmux", View, Own)).toEqual({
			file: "tmux",
			args: ["select-pane", "-L"],
			env: { PATH: "/view", TMUX_PANE: "%2" },
		});
	});

	it("runs nothing on the printed route, which names no route", () => {
		expect(buildFocusReturn(undefined, View, Own)).toBeNull();
	});

	it("gives each split's route a return", () => {
		const offered = routes({ WSL_INTEROP: "/run/x", TMUX: "/t" });
		for (const route of offered)
			expect(buildFocusReturn(route.args.at(-1), View, Own)).not.toBeNull();
	});
});
