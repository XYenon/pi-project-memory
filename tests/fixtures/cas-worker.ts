import { access } from "node:fs/promises";
import { createChildTools } from "../../src/child-tools.ts";

const [memoryDir, projectRoot, locksDir, filePath, marker, replacement] = process.argv.slice(2);
if (!memoryDir || !projectRoot || !locksDir || !filePath || !marker || replacement === undefined)
	throw new Error("usage: cas-worker <memory> <project> <locks> <file> <barrier> <replacement>");

const tools = createChildTools({
	mode: "extractor",
	memoryDir,
	projectRoot,
	cwd: projectRoot,
	locksDir,
	isCurrentGeneration: () => true,
	touchedPaths: new Set(),
});
const read = tools.find((tool) => tool.name === "read");
const edit = tools.find((tool) => tool.name === "edit");
if (!read || !edit) throw new Error("missing child tools");
const readResult = await read.execute("read", { path: filePath });
if (readResult.isError) throw new Error("initial read failed");
process.stdout.write("ready\n");
while (true) {
	try {
		await access(marker);
		break;
	} catch {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
const result = await edit.execute("edit", { path: filePath, edits: [{ oldText: "initial", newText: replacement }] });
process.stdout.write(`${JSON.stringify({ isError: result.isError === true })}\n`);
