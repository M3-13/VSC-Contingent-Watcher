import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBaseForHost } from '../core/endpoints';

test('github.com maps to api.github.com', () => {
  assert.equal(apiBaseForHost('github.com'), 'https://api.github.com');
  assert.equal(apiBaseForHost('api.github.com'), 'https://api.github.com');
});

test('GHE.com tenant maps to api.<tenant>.ghe.com', () => {
  assert.equal(apiBaseForHost('acme.ghe.com'), 'https://api.acme.ghe.com');
  assert.equal(apiBaseForHost('ACME.GHE.COM'), 'https://api.acme.ghe.com');
});

test('GHE Server maps to /api/v3', () => {
  assert.equal(apiBaseForHost('github.acme.corp'), 'https://github.acme.corp/api/v3');
});
