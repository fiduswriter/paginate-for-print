import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import license from "rollup-plugin-license";

const plugins = [
	typescript({
		tsconfig: "./tsconfig.rollup.json",
		exclude: ["src/**/*.test.ts"],
	}),
	nodeResolve({
		extensions: [".cjs", ".mjs", ".js"],
	}),
	commonjs({
		include: [
			"node_modules/**",
			"../pages-to-pdf/node_modules/**"
		],
		transformMixedEsModules: true
	}),
	json(),
	license({
		banner:
			" @license paginate-for-print v<%= pkg.version %>\n" +
			"\n" +
			" Copyright (C) 2026 Johannes Wilm\n" +
			" Licensed under the GNU Lesser General Public License, version 3 or later\n" +
			" (LGPL-3.0-or-later). See COPYING.LESSER and LICENSE.md for details.",
	}),
];

export default [
	// Polyfill bundle used by printHTML when paginating in a hidden iframe.
	{
		input: "./src/polyfill/polyfill.ts",
		output: {
			name: "PaginatePolyfill",
			file: "./dist/paginate.polyfill.js",
			format: "umd",
			sourcemap: true,
		},
		plugins: plugins,
	},

	// Public API: print + PDF export (ESM only).
	// pages-to-pdf is external so consumers bring their own copy and the bundle
	// stays small.
	{
		input: "./src/paginate.ts",
		external: ["pages-to-pdf"],
		output: {
			file: "./dist/paginate.js",
			format: "es",
			sourcemap: true,
		},
		plugins: plugins,
	},

	// Minified public API.
	{
		input: "./src/paginate.ts",
		external: ["pages-to-pdf"],
		output: {
			file: "./dist/paginate.min.js",
			format: "es",
			sourcemap: true,
		},
		plugins: [plugins, terser()],
	},

	// Self-contained API bundle for the examples' direct browser import:
	// `pages-to-pdf` is bundled in (unlike the npm entries above), because a
	// browser cannot resolve the bare package specifier. Demo-only; not
	// listed in package.json "files".
	{
		input: "./src/paginate.ts",
		output: {
			file: "./dist/paginate.demo.js",
			format: "es",
			sourcemap: true,
			inlineDynamicImports: true,
		},
		plugins: plugins,
	},
];
