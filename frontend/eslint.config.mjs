// @ts-check
// ESLint flat config for the Angular frontend. Biome handles
// formatting + general JS/TS lint for the backend; this file adds
// Angular-semantic rules that Biome doesn't know about.
//
// Currently focused on:
//   - component-max-inline-declarations(0,0): forbid inlined
//     `template:` / `styles:` strings in the @Component decorator.
//     Every component must use templateUrl / styleUrl pointing at
//     sibling .html / .scss files (see the
//     angular-external-template-style rule in the team's memory).
//   - template/accessibility: the standard a11y rule set for HTML
//     templates.

import angular from "angular-eslint";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		files: ["src/**/*.ts"],
		extends: [
			// Type-aware: without a project the rules that need types — notably
			// no-base-to-string / restrict-template-expressions, the ones that stop
			// a value rendering as `[object Object]` — load but never fire.
			...tseslint.configs.recommendedTypeChecked,
			...tseslint.configs.stylisticTypeChecked,
			...angular.configs.tsRecommended,
		],
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		processor: angular.processInlineTemplates,
		rules: {
			"@angular-eslint/component-max-inline-declarations": ["error", { template: 0, styles: 0 }],
			// Don't warn about empty constructors or strict-style preferences
			// that fight Angular's idioms (DI via constructor injection still
			// produces "useless constructor" warnings in some flows).
			"@typescript-eslint/no-empty-function": "off",
			// `x as Shape` is a claim, not a check — and it is the one hole left in
			// the protection against a value reaching the screen in the wrong
			// shape. The type-aware rules above, and dev-lint's
			// DL-ANGULAR-STRINGIFIED-OBJECT over the templates, both reason from
			// the declared types; the only way to fool them is with a type we
			// manufactured ourselves. Narrow at the boundary instead — ./src/app/narrow.ts.
			"@typescript-eslint/no-unsafe-type-assertion": "error",
		},
	},
	{
		// A double asserted into the interface it stands in for is the whole
		// point of a double; getting it wrong fails a test, it never reaches a
		// user. App code stays strict.
		files: ["src/**/*.spec.ts"],
		rules: {
			"@typescript-eslint/no-unsafe-type-assertion": "off",
		},
	},
	{
		files: ["src/**/*.html"],
		extends: [
			...angular.configs.templateRecommended,
			...angular.configs.templateAccessibility,
		],
	},
);
