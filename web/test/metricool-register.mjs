// Installs test/metricool-module-hooks.mjs before the test module graph is built.
import { register } from 'node:module';
register('./metricool-module-hooks.mjs', import.meta.url);
