import { writeFakeBin } from "./fake-bin";

export const writeWslpath = (dir: string) =>
	writeFakeBin(dir, "wslpath", `printf '%s' "$2"`);
