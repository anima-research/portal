import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffImageMediaType } from '../src/server.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');

test('labels images from their bytes, not the declared type', () => {
  assert.equal(sniffImageMediaType(PNG), 'image/png');
  assert.equal(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageMediaType(Buffer.from('GIF89a', 'ascii')), 'image/gif');
  assert.equal(sniffImageMediaType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp');
  assert.equal(sniffImageMediaType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined);
});
