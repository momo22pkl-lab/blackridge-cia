'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = require('../package.json');

test('the configured start command points to an existing server entry point', () => {
  const match = /^node\s+(.+)$/.exec(packageJson.scripts.start);
  assert.ok(match, 'start script should run Node directly');
  assert.ok(
    fs.existsSync(path.resolve(projectRoot, match[1])),
    `start entry point "${match[1]}" must exist`
  );
});
