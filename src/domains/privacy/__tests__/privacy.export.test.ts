import { describe, it, expect, beforeEach, vi } from 'vitest';
import { inflateRawSync } from 'node:zlib';

vi.mock('../../../lib/queue', () => ({
  accountDeletionQueue: { add: vi.fn(), remove: vi.fn() },
}));
vi.mock('../../notifications/email', () => ({
  enqueueEmail: vi.fn().mockResolvedValue('job-1'),
}));

import { PrivacyService } from '../privacy.service';
import { NotFoundError } from '../../../utils/errors';

/**
 * Regression tests for issue #220's ZIP export requirement: "full data export
 * returns a ZIP download" (not JSON/CSV in the response body, as the old
 * `GET /api/v1/privacy/export` route did).
 *
 * The ZIP signature bytes (`PK\x03\x04` local file header, `PK\x05\x06` end of
 * central directory) are the literal values defined by the ZIP file format
 * spec, not anything read back from the implementation, so these assertions
 * would fail just as surely if `exportUserDataAsZip` silently returned a plain
 * JSON or CSV buffer instead of a real archive.
 */
describe('PrivacyService.exportUserDataAsZip (#220)', () => {
  const userId = 'user-export';
  let mockPrisma: any;
  let service: PrivacyService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = { user: { findUnique: vi.fn() } };
    service = new PrivacyService(mockPrisma);
  });

  it('throws NotFoundError when the user does not exist', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(service.exportUserDataAsZip(userId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns a buffer with a real ZIP local-file-header signature (PK\\x03\\x04)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      name: 'Export Test',
      password: 'super-secret-hash',
      createdAt: new Date(),
      wallets: [],
      tips: [],
      payments: [],
      creator: null,
    });

    const result = await service.exportUserDataAsZip(userId);

    expect(result.buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(result.filename).toBe('dorisio-data-export.zip');
  });

  it('includes a real end-of-central-directory record (PK\\x05\\x06) so the archive is a complete, valid ZIP', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      name: 'Export Test',
      password: 'super-secret-hash',
      createdAt: new Date(),
      wallets: [],
      tips: [],
      payments: [],
      creator: null,
    });

    const result = await service.exportUserDataAsZip(userId);
    const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const index = result.buffer.lastIndexOf(eocdSignature);

    expect(index).toBeGreaterThan(-1);
  });

  it('stores the entry filename "data.json" as plain text in the archive (ZIP never compresses filenames)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      name: 'Export Test',
      password: 'super-secret-hash',
      createdAt: new Date(),
      wallets: [],
      tips: [],
      payments: [],
      creator: null,
    });

    const result = await service.exportUserDataAsZip(userId);
    expect(result.buffer.includes('data.json')).toBe(true);
  });

  it('never includes the password hash in the exported content, even deflated', async () => {
    const distinctivePasswordHash = 'zzzz-distinctive-password-hash-zzzz';
    mockPrisma.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      name: 'Export Test',
      password: distinctivePasswordHash,
      createdAt: new Date(),
      wallets: [],
      tips: [],
      payments: [],
      creator: null,
    });

    const result = await service.exportUserDataAsZip(userId);
    const json = inflateEntry(result.buffer);

    expect(json).not.toContain(distinctivePasswordHash);
    expect(JSON.parse(json).user.password).toBeUndefined();
  });

  it('round-trips the real exported data (email, tips, payments) through actual DEFLATE decompression', async () => {
    const distinctiveEmail = 'distinctive-export-check@example.com';
    mockPrisma.user.findUnique.mockResolvedValue({
      id: userId,
      email: distinctiveEmail,
      name: 'Export Test',
      password: 'hash',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      wallets: [{ id: 'wallet-1', publicKey: 'GABC', verified: true }],
      tips: [{ id: 'tip-1', status: 'completed' }],
      payments: [{ id: 'pay-1', amount: 10 }],
      creator: null,
    });

    const result = await service.exportUserDataAsZip(userId);
    const parsed = JSON.parse(inflateEntry(result.buffer));

    expect(parsed.user.email).toBe(distinctiveEmail);
    expect(parsed.wallets).toHaveLength(1);
    expect(parsed.tips[0].id).toBe('tip-1');
    expect(parsed.payments[0].amount).toBe(10);
  });
});

/**
 * Minimal ZIP reader for the single-entry archive `exportUserDataAsZip`
 * produces. `archiver` streams its output, so it sets the general-purpose bit
 * 3 flag and writes 0 for the compressed/uncompressed sizes in the local file
 * header (the real sizes follow in a data descriptor after the compressed
 * bytes). The central directory record (always at a fixed, discoverable
 * position via the end-of-central-directory record) is written after
 * `finalize()` with the real sizes, so this reads sizes from there and only
 * uses the local header to locate the start of the compressed bytes. This
 * avoids pulling in an extra unzip dependency just for test verification.
 */
function inflateEntry(buffer: Buffer): string {
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocdIndex = buffer.lastIndexOf(eocdSignature);
  if (eocdIndex === -1) {
    throw new Error('End of central directory record not found');
  }

  const centralDirOffset = buffer.readUInt32LE(eocdIndex + 16);
  if (buffer.readUInt32LE(centralDirOffset) !== 0x02014b50) {
    throw new Error('Central directory file header not found at expected offset');
  }

  const compressedSize = buffer.readUInt32LE(centralDirOffset + 20);
  const localHeaderOffset = buffer.readUInt32LE(centralDirOffset + 42);

  if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new Error('Local file header not found at expected offset');
  }
  const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const localExtraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;

  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
  return inflateRawSync(compressed).toString('utf8');
}
