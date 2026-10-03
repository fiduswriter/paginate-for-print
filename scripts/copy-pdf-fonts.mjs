// Ships the bundled PDF fallback fonts next to the built bundles.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = process.env.PDF_FONTS_SRC || join(root, "assets", "fonts");
const to = join(root, "dist", "fonts");

mkdirSync(to, { recursive: true });
const fonts = [
	"LibertinusSerif-Regular.ttf",
	"LibertinusSerif-Bold.ttf",
	"LibertinusSerif-Italic.ttf",
	"LibertinusSerif-BoldItalic.ttf",
	"LiberationSerif-Regular.ttf",
	"LiberationSerif-Bold.ttf",
	"LiberationSerif-Italic.ttf",
	"LiberationSerif-BoldItalic.ttf",
	"LiberationSans-Regular.ttf",
	"LiberationSans-Bold.ttf",
	"LiberationSans-Italic.ttf",
	"LiberationSans-BoldItalic.ttf",
	"LiberationMono-Regular.ttf",
	"LiberationMono-Bold.ttf",
	"LiberationMono-Italic.ttf",
	"LiberationMono-BoldItalic.ttf",
	"JetBrainsMono-Regular.ttf",
	"JetBrainsMono-Bold.ttf",
	"DejaVuSans.ttf",
];
let copied = 0;
for (const f of fonts) {
	try {
		copyFileSync(join(from, f), join(to, f));
		copied++;
	} catch {
		// Source font unavailable (e.g. trimmed checkout): export proceeds with
		// the document's own @font-face fonts and skips unavailable fallbacks.
	}
}
console.log(`pdf fonts: ${copied}/${fonts.length} copied to dist/fonts`);
