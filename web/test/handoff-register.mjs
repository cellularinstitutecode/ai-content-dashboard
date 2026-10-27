// Installs test/handoff-module-hooks.mjs before the test module graph is built.
import { register } from 'node:module';
register('./handoff-module-hooks.mjs', import.meta.url);
