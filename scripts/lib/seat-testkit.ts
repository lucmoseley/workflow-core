import path from "node:path";

export const seatDirs = (home: string): string[] =>
	[".claude", ".claude2", ".claude3"].map((d) => path.join(home, d));

export const seatEnv = (home: string): Record<string, string> => ({
	CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
	WFC_CLAUDE_CONFIG_A: "",
	WFC_CLAUDE_CONFIG_B: "",
	WFC_CLAUDE_CONFIG_C: "",
});
