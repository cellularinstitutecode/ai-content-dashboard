// Installs test/row-ticks-module-hooks.mjs before the test module graph is built.
import { register } from 'node:module';
register('./row-ticks-module-hooks.mjs', import.meta.url);
