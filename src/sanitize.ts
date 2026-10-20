const ALLOWED_DEFAULT_IGNORABLES = new Set([0x200c, 0x200d, 0xfe0e, 0xfe0f]);
const DANGEROUS_UNICODE = /^[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}]$/u;

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?|[\u2028\u2029]/g, "\n");
}

function cleanDangerousCharacters(value: string): string {
	let result = "";
	for (const character of normalizeLineEndings(value)) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint === 9 || codePoint === 10 || ALLOWED_DEFAULT_IGNORABLES.has(codePoint)) {
			result += character;
			continue;
		}
		if (codePoint < 32 || (codePoint >= 127 && codePoint <= 159)) continue;
		if (DANGEROUS_UNICODE.test(character)) continue;
		result += character;
	}
	return result;
}

const RESERVED_TAG_NAMES = [
	"system-reminder",
	"system_reminder",
	"function_results",
	"function_calls",
	"tool_use",
	"tool_result",
	"tool_use_error",
	"sandbox_violations",
	"persisted-output",
	"total_tokens",
	"user-prompt-submit-hook",
	"bash-input",
	"bash-stdout",
	"bash-stderr",
	"bash-exit-code",
	"local-command-stdout",
	"local-command-stderr",
	"local-command-caveat",
	"command-name",
	"command-message",
	"command-args",
	"task-notification",
	"agent-message",
	"teammate-message",
	"cross-session-message",
	"remote-review",
	"slack-ping",
	"slack-tag-message",
	"tick",
	"fetched-web-content",
	"coordinator-relay",
	"channel",
	"cowritten-artifact-html",
	"artifact-type-instructions",
	"artifact-file-content",
	"artifact-origin-notes",
	"artifact-stored-declaration",
	"antml",
	"assistant",
	"human",
	"user",
	"system",
];
const RESERVED_TAGS = new Set(RESERVED_TAG_NAMES.map((tag) => tag.replaceAll("-", "_")));

const ANGLE_CONFUSABLES = new Set([
	"<",
	"\uFF1C",
	"\uFE64",
	"\u2329",
	"\u27E8",
	"\u3008",
	"\u2039",
	"\u02C2",
	"\u1438",
	"\u276C",
	"\u276E",
	"\u2770",
	"\u29FC",
	"\u226E",
	"\u227A",
	"\u22D6",
]);
const SLASH_CONFUSABLES = new Set(["/", "\uFF0F", "\u2215", "\u2044"]);
const CLOSE_ANGLE_CONFUSABLES = new Set([
	">",
	"\uFF1E",
	"\uFE65",
	"\u232A",
	"\u27E9",
	"\u3009",
	"\u203A",
	"\u02C3",
	"\u1433",
	"\u276D",
	"\u276F",
	"\u2771",
	"\u29FD",
	"\u226F",
	"\u227B",
	"\u22D7",
]);
const DASH_OR_UNDERSCORE = /^[\p{Pd}\p{Pc}\u02CD\u0640\u07FA\u2017\u2043\u207B\u208B\u2212\u2796\u30FC\uFF70]$/u;
const TAG_FILLER = /^[\p{M}\p{Default_Ignorable_Code_Point}]$/u;

// Unicode normalization handles styled and accented Latin letters. These are
// non-decomposing confusables used by Claude Code's harness-tag scrubber.
const LETTER_CONFUSABLES: Readonly<Record<string, string>> = {
	а: "a",
	ɑ: "a",
	α: "a",
	ᴀ: "a",
	ⱥ: "a",
	ꭺ: "a",
	Ꜳ: "a",
	Ꞻ: "a",
	Ь: "b",
	В: "b",
	β: "b",
	ʙ: "b",
	Ꞗ: "b",
	ꮟ: "b",
	ꓐ: "b",
	с: "c",
	ϲ: "c",
	ᴄ: "c",
	ꮯ: "c",
	ꓚ: "c",
	ⲥ: "c",
	ԁ: "d",
	Ԁ: "d",
	ᴅ: "d",
	ꭰ: "d",
	ꮷ: "d",
	ꓓ: "d",
	е: "e",
	ε: "e",
	ᴇ: "e",
	ꭼ: "e",
	ꓰ: "e",
	ⲉ: "e",
	ꜰ: "f",
	ꓝ: "f",
	ɡ: "g",
	ɢ: "g",
	գ: "g",
	ꭶ: "g",
	ꓖ: "g",
	һ: "h",
	Η: "h",
	ʜ: "h",
	հ: "h",
	ꮋ: "h",
	ꮒ: "h",
	ꓧ: "h",
	і: "i",
	ı: "i",
	ι: "i",
	ɩ: "i",
	ɪ: "i",
	Ɪ: "i",
	ꓲ: "i",
	ⲓ: "i",
	ј: "j",
	ϳ: "j",
	ᴊ: "j",
	ꭻ: "j",
	ꓙ: "j",
	к: "k",
	κ: "k",
	ᴋ: "k",
	ꮶ: "k",
	ꓗ: "k",
	ⲕ: "k",
	ӏ: "l",
	ʟ: "l",
	ⅼ: "l",
	ꮮ: "l",
	ꓡ: "l",
	м: "m",
	Μ: "m",
	ᴍ: "m",
	ꮇ: "m",
	ꓟ: "m",
	ⲙ: "m",
	ո: "n",
	Ν: "n",
	ɴ: "n",
	ꓠ: "n",
	ⲛ: "n",
	о: "o",
	ο: "o",
	ᴏ: "o",
	օ: "o",
	ꭴ: "o",
	ꓳ: "o",
	ⲟ: "o",
	р: "p",
	ρ: "p",
	ᴘ: "p",
	ꮲ: "p",
	ꓑ: "p",
	ⲣ: "p",
	ԛ: "q",
	ք: "q",
	ʀ: "r",
	ꭱ: "r",
	ꓣ: "r",
	ѕ: "s",
	ſ: "s",
	ꜱ: "s",
	ꮪ: "s",
	ꓢ: "s",
	т: "t",
	τ: "t",
	ᴛ: "t",
	ꭲ: "t",
	ꓔ: "t",
	ⲧ: "t",
	υ: "u",
	ᴜ: "u",
	ս: "u",
	ꓴ: "u",
	ν: "v",
	ᴠ: "v",
	ѵ: "v",
	ꮩ: "v",
	ꓦ: "v",
	ԝ: "w",
	ᴡ: "w",
	ꮃ: "w",
	ꮤ: "w",
	ꓪ: "w",
	х: "x",
	χ: "x",
	ꭓ: "x",
	ꓫ: "x",
	ⲭ: "x",
	у: "y",
	Υ: "y",
	ʏ: "y",
	ꭹ: "y",
	ꓬ: "y",
	ⲩ: "y",
	Ζ: "z",
	ᴢ: "z",
	ꓜ: "z",
	ⲍ: "z",
};

function tagCharacterSkeleton(character: string): string | null {
	if (TAG_FILLER.test(character)) return "";
	if (DASH_OR_UNDERSCORE.test(character)) return "_";
	const mapped = LETTER_CONFUSABLES[character] ?? LETTER_CONFUSABLES[character.toLowerCase()];
	if (mapped) return mapped;
	const normalized = character
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replaceAll("ß", "ss");
	return /^[a-z0-9_-]+$/.test(normalized) ? normalized : null;
}

function isInitialTagFiller(character: string): boolean {
	return (
		!ANGLE_CONFUSABLES.has(character) &&
		!CLOSE_ANGLE_CONFUSABLES.has(character) &&
		!SLASH_CONFUSABLES.has(character) &&
		tagCharacterSkeleton(character) === null
	);
}

function skipInitialTagFiller(characters: string[], start: number): number {
	let cursor = start;
	while (cursor < characters.length) {
		const character = characters[cursor];
		if (character === undefined || !isInitialTagFiller(character)) break;
		cursor++;
	}
	return cursor;
}

function reservedTagAt(characters: string[], start: number): boolean {
	let cursor = skipInitialTagFiller(characters, start + 1);
	if (SLASH_CONFUSABLES.has(characters[cursor] ?? "")) cursor++;
	cursor = skipInitialTagFiller(characters, cursor);

	let tag = "";
	for (; cursor < characters.length && tag.length <= 64; cursor++) {
		const character = characters[cursor];
		if (character === undefined) break;
		const skeleton = tagCharacterSkeleton(character);
		if (skeleton === null) break;
		tag += skeleton;
	}
	return RESERVED_TAGS.has(tag);
}

function neutralizeReservedTags(value: string): string {
	const characters = [...value];
	let result = "";
	for (const [index, character] of characters.entries()) {
		if (ANGLE_CONFUSABLES.has(character) && reservedTagAt(characters, index)) result += "&lt;";
		else result += character;
	}
	return result;
}

export function sanitizeMemoryText(value: string): string {
	// Claude's local memory index and recall path uses Loe(s(value)): dangerous
	// controls and format characters are dropped before reserved tags are scrubbed.
	return neutralizeReservedTags(cleanDangerousCharacters(value));
}

export function hasUnsafeMemoryText(value: string): boolean {
	return sanitizeMemoryText(value) !== normalizeLineEndings(value);
}
