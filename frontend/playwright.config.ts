import { defineConfig, devices } from "@playwright/test";
import { phoneConfig } from "@xinutec/ui-harness/config";
import harness from "./e2e/harness.mjs";

/**
 * Playwright UI-render checks — NOT a behavioural suite. They render pages in a
 * real browser at true phone geometry and assert measurable facts about the
 * pixels (no text overlaps, nothing overflows the width). jsdom has no fonts or
 * layout, so a collision that reads fine in source only shows in the render.
 *
 * Everything shared — the Pixel geometry, the port, the static server serving
 * the PRODUCTION build, the golden tolerances — comes from @xinutec/ui-harness;
 * see dev-lint/docs/layout-quality-architecture.md. What this app says about
 * itself is in e2e/harness.mjs.
 *
 * `npm run ui-check` (wired into verify.sh after `ng build`) serves the
 * freshly-built dist. Both the dashboard layout harness (e2e/ui-pages.spec.ts)
 * and the settings overlap spec (e2e/settings.spec.ts) run here — this app has
 * no dev-serve-dependent behavioural specs.
 */
export default defineConfig(phoneConfig(harness, devices, { goldens: true }));
