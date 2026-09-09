// Apply the app's existing Hooks checks to catalog-only files without changing
// the production lint configuration or its population.
import applicationRules from "../eslint.config.js";

export default applicationRules.map((rule) => rule.files
  ? { ...rule, files: ["design-system/**/*.{ts,tsx}"] }
  : rule);
