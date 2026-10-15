import { access } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock } from "../../src/store.ts";

const [locksDir, key, mode = "hold", duration = "500", stale = "100"] = process.argv.slice(2);
if (!locksDir || !key)
	throw new Error("usage: lock-worker <locks-dir> <key> [hold|hold-file|crash] [duration-ms|release-file] [stale-ms]");

const release = await acquireLock(join(locksDir, `${key}.lock`), Number(stale));
if (!release) throw new Error("lock is busy");
process.stdout.write("acquired\n");
if (mode === "crash") process.exit(0);
if (mode === "hold-file") {
	for (;;) {
		try {
			await access(duration);
			break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
} else await new Promise((resolve) => setTimeout(resolve, Number(duration)));
await release();
