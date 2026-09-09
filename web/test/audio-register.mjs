// Installs the resolution hooks for the audio-extraction test. Loaded via
// `node --import ./test/audio-register.mjs` so the hooks are in place before
// the test module graph is built.
import { register } from 'node:module';
register('./audio-module-hooks.mjs', import.meta.url);
