import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveSafePath, ALLOWED_UPLOAD_MIME_TYPES } from '../src/path-security.js';

test('resolveSafePath accepts a valid file within allowed base directory', async () => {
  const sandbox = resolve(tmpdir(), `glpi-test-safe-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });

  const testFile = join(sandbox, 'document.pdf');
  await writeFile(testFile, 'dummy pdf content');

  try {
    const res = await resolveSafePath(testFile, sandbox);
    assert.equal(res.filename, 'document.pdf');
    assert.equal(res.mimeType, 'application/pdf');
    assert.equal(res.resolvedPath, testFile);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('resolveSafePath rejects path traversal attempts outside allowed base directory', async () => {
  const sandbox = resolve(tmpdir(), `glpi-test-traversal-${Date.now()}`);
  const subDir = join(sandbox, 'sub');
  await mkdir(subDir, { recursive: true });

  const outsideFile = join(sandbox, 'outside.pdf');
  await writeFile(outsideFile, 'secret outside');

  try {
    await assert.rejects(
      async () => {
        await resolveSafePath('../outside.pdf', subDir);
      },
      /outside the allowed directory/
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('resolveSafePath rejects sensitive files like .env or keys', async () => {
  const sandbox = resolve(tmpdir(), `glpi-test-sensitive-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });

  const envFile = join(sandbox, '.env');
  await writeFile(envFile, 'SECRET=123');

  try {
    await assert.rejects(
      async () => {
        await resolveSafePath(envFile, sandbox);
      },
      /restricted for security/
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('resolveSafePath rejects disallowed file extensions', async () => {
  const sandbox = resolve(tmpdir(), `glpi-test-ext-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });

  const scriptFile = join(sandbox, 'malicious.sh');
  await writeFile(scriptFile, 'echo hacked');

  try {
    await assert.rejects(
      async () => {
        await resolveSafePath(scriptFile, sandbox);
      },
      /restricted for security|Unsupported or disallowed file extension/
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('resolveSafePath rejects directories and null bytes', async () => {
  const sandbox = resolve(tmpdir(), `glpi-test-dir-${Date.now()}`);
  const innerDir = join(sandbox, 'folder');
  await mkdir(innerDir, { recursive: true });

  try {
    await assert.rejects(
      async () => {
        await resolveSafePath(innerDir, sandbox);
      },
      /Target is not a regular file/
    );

    await assert.rejects(
      async () => {
        await resolveSafePath('file.pdf\0.png', sandbox);
      },
      /contains null byte/
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
