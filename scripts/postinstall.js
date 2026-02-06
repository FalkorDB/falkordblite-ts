#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');

async function main() {
  // In development the dist/ directory may not exist yet (TypeScript hasn't
  // been compiled). Skip gracefully — the developer can run
  // `npm run build && npm run postinstall` manually.
  const binaryManagerPath = path.join(__dirname, '..', 'dist', 'binary-manager.js');
  if (!fs.existsSync(binaryManagerPath)) {
    console.log(
      'falkordblite: Skipping postinstall — dist/ not built yet.\n' +
      '  Run "npm run build && npm run postinstall" for local development.',
    );
    return;
  }

  const { BinaryManager } = require(binaryManagerPath);

  try {
    const manager = new BinaryManager();
    const paths = await manager.ensureBinaries();

    console.log('falkordblite: Binary setup complete.');
    console.log(`  redis-server:    ${paths.redisServerPath}`);
    console.log(`  FalkorDB module: ${paths.falkordbModulePath}`);
  } catch (err) {
    // Never fail the install — warn and give troubleshooting advice.
    console.warn('\nfalkordblite: Binary setup incomplete.\n');
    console.warn(`  ${err.message}\n`);
    console.warn(
      'You can still use falkordblite by providing binary paths manually:\n' +
      '  const db = await FalkorDB.open({\n' +
      '    redisServerPath: "/path/to/redis-server",\n' +
      '    modulePath: "/path/to/falkordb.so",\n' +
      '  });\n',
    );
  }
}

main();
