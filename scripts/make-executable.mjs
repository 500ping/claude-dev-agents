import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
const file = new URL('../dist/cli.js', import.meta.url);
let src = readFileSync(file, 'utf8');
if (!src.startsWith('#!')) src = '#!/usr/bin/env node\n' + src;
writeFileSync(file, src);
chmodSync(file, 0o755);
