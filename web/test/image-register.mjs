// Installs the resolution hooks for the image-pipeline test. Loaded via
// `node --import ./test/image-register.mjs` so the hooks are in place before
// the test module graph is built.
import { register } from 'node:module';
register('./image-module-hooks.mjs', import.meta.url);
