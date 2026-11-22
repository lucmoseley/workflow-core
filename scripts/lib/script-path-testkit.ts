const SCRIPT_PATH_PATTERN = String.raw`(?:\.\/)?scripts\/[\w./-]+\.(?:js|sh|py)`;

export const COMMAND_SHAPED = new RegExp(
	String.raw`(?:\b(?:node|bash|sh|source|python3?)\s+|\$\()${SCRIPT_PATH_PATTERN}|\`${SCRIPT_PATH_PATTERN}\s[^\`]`,
);

export const PLAIN_POINTER = new RegExp(
	String.raw`(?<![\w./$}-])${SCRIPT_PATH_PATTERN}\s+[\w<[-]`,
);
