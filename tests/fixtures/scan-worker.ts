import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { backfillIndex, INDEX_LINE_CAP, scanTopics, TOPIC_SCAN_CAP } from "../../src/store.ts";

const [memoryDir] = process.argv.slice(2);
if (!memoryDir) throw new Error("Expected a memory directory");
const topics = await scanTopics(memoryDir);
assert.equal(topics.length, TOPIC_SCAN_CAP);
assert.deepEqual(
	topics.map((topic) => topic.filename),
	Array.from({ length: TOPIC_SCAN_CAP }, (_, index) => `topic-${299 - index}.md`),
);
assert.equal(await backfillIndex(memoryDir), true);
const index = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
assert.equal(index.trim().split("\n").length, Math.floor(INDEX_LINE_CAP * 0.8));
assert.match(index.split("\n")[0]!, /topic-299\.md/);
console.log("scan and backfill passed");
