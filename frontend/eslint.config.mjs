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
