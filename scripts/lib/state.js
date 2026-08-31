'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Read the persisted state file. Returns `null` if it does not exist.
 * @param {string} statePath
 */
function readState(statePath) {
  if (!fs.existsSync(statePath)) {
    return null;
  }
  const raw = fs.readFileSync(statePath, 'utf8');
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse state file at ${statePath}: ${err.message}`);
  }
}

/**
 * Persist state to disk, creating parent directories as needed.
 * @param {string} statePath
 * @param {object} state
 */
function writeState(statePath, state) {
  const dir = path.dirname(statePath);
  if (dir && dir !== '.') {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

module.exports = { readState, writeState };
