import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseGlpiConfig } from '../src/config.js';

test('parseGlpiConfig accepts valid HTTPS configuration', () => {
  const env: NodeJS.ProcessEnv = {
    GLPI_URL: 'https://glpi.company.com',
    GLPI_USER_TOKEN: 'valid-token',
  };

  const config = parseGlpiConfig(env);
  assert.equal(config.url, 'https://glpi.company.com');
  assert.equal(config.userToken, 'valid-token');
});

test('parseGlpiConfig rejects unencrypted HTTP URLs by default', () => {
  const env: NodeJS.ProcessEnv = {
    GLPI_URL: 'http://glpi.company.com',
    GLPI_USER_TOKEN: 'valid-token',
  };

  assert.throws(
    () => parseGlpiConfig(env),
    /Insecure protocol "http:" rejected for GLPI_URL/
  );
});

test('parseGlpiConfig allows HTTP only when GLPI_ALLOW_HTTP is explicitly set', () => {
  const env: NodeJS.ProcessEnv = {
    GLPI_URL: 'http://localhost:8080',
    GLPI_USER_TOKEN: 'valid-token',
    GLPI_ALLOW_HTTP: 'true',
  };

  const config = parseGlpiConfig(env);
  assert.equal(config.url, 'http://localhost:8080');
  assert.equal(config.userToken, 'valid-token');
});

test('parseGlpiConfig requires at least one authentication method', () => {
  const env: NodeJS.ProcessEnv = {
    GLPI_URL: 'https://glpi.company.com',
  };

  assert.throws(
    () => parseGlpiConfig(env),
    /No authentication configured/
  );
});

test('parseGlpiConfig rejects malformed URLs', () => {
  const env: NodeJS.ProcessEnv = {
    GLPI_URL: 'not-a-valid-url',
    GLPI_USER_TOKEN: 'valid-token',
  };

  assert.throws(
    () => parseGlpiConfig(env),
    /GLPI_URL is not a valid URL/
  );
});
