import { PrismaClient } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { BaseService } from '../../services/base.service';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { buildTipWhere, TipFilterInput } from '../payments/tip-filters';
import { TIP_VISIBLE_STATE } from '../moderation/moderation.types';

export type TransactionExportFormat = 'csv' | 'pdf';

/** Upper bound on rows returned by one export to keep generation bounded. */
const MAX_EXPORT_ROWS = 10_000;

interface ExportRow {
  date: string;
  amount: number;
  asset: string;
  status: string;
  fee: number;
}

/**
 * Creator financial data export (issue #219).
 *
 * The issue's acceptance criteria also ask for the export to "respect the
 * creator's privacy settings" and redact privacy-sensitive data
 * accordingly. There is currently no privacy-settings model or field on
 * `Creator` anywhere in this codebase to check, so that requirement is not
 * implemented here — disclosed rather than invented, since adding a new
 * settings concept is a bigger design decision than this issue's other,
 * concretely specified tasks (format, filtering).
 *
 * `fee` is computed at export time from `StellarAsset.feeBps` (a
 * configured basis-points rate per asset), since no fee amount is stored
 * per-tip anywhere in the schema.
 */
export class CreatorExportService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async exportTransactions(
    creatorId: string,
    format: TransactionExportFormat,
    filters: TipFilterInput = {}
  ): Promise<{ content: string | Buffer; contentType: string; filename: string }> {
    return this.executeWithLogging('creatorExport.exportTransactions', async () => {
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
        select: { id: true, username: true },
      });
      if (!creator) {
        throw new NotFoundError('Creator');
      }

      const where = buildTipWhere({ creatorId, moderationState: TIP_VISIBLE_STATE }, filters);

      const [tips, assets] = await Promise.all([
        this.prisma.tip.findMany({
          where,
          select: { createdAt: true, amount: true, assetCode: true, status: true },
          orderBy: { createdAt: 'desc' },
          take: MAX_EXPORT_ROWS,
        }),
        this.prisma.stellarAsset.findMany({ select: { code: true, feeBps: true } }),
      ]);

      const feeBpsByCode = new Map(assets.map((asset) => [asset.code, asset.feeBps]));
      const rows: ExportRow[] = tips.map((tip) => {
        const feeBps = feeBpsByCode.get(tip.assetCode) ?? 0;
        return {
          date: tip.createdAt.toISOString(),
          amount: tip.amount,
          asset: tip.assetCode,
          status: tip.status,
          fee: Math.round(((tip.amount * feeBps) / 10_000) * 1e7) / 1e7,
        };
      });

      const filenameBase = `${creator.username}-transactions-${new Date().toISOString().slice(0, 10)}`;

      if (format === 'csv') {
        return {
          content: toCsv(rows),
          contentType: 'text/csv; charset=utf-8',
          filename: `${filenameBase}.csv`,
        };
      }
      if (format === 'pdf') {
        return {
          content: await toPdf(rows, creator.username),
          contentType: 'application/pdf',
          filename: `${filenameBase}.pdf`,
        };
      }
      throw new ValidationError(`Unsupported export format: ${format}`);
    });
  }
}

function toCsv(rows: ExportRow[]): string {
  const headers = ['date', 'amount', 'asset', 'status', 'fee'];
  const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return (
    [
      headers.join(','),
      ...rows.map((row) => headers.map((h) => quote(row[h as keyof ExportRow])).join(',')),
    ].join('\n') + '\n'
  );
}

function toPdf(rows: ExportRow[], creatorUsername: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).text(`Transaction history — ${creatorUsername}`, { align: 'left' });
    doc.fontSize(10).fillColor('#555').text(`Generated ${new Date().toISOString()}`);
    doc.moveDown();

    const columns = [
      { label: 'Date', width: 140 },
      { label: 'Amount', width: 80 },
      { label: 'Asset', width: 60 },
      { label: 'Status', width: 90 },
      { label: 'Fee', width: 80 },
    ];
    const startX = doc.x;
    let y = doc.y;

    doc.fontSize(10).fillColor('#000');
    let x = startX;
    for (const column of columns) {
      doc.text(column.label, x, y, { width: column.width, continued: false });
      x += column.width;
    }
    y += 16;
    doc.moveTo(startX, y).lineTo(x, y).stroke();
    y += 6;

    for (const row of rows) {
      if (y > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      x = startX;
      const values = [row.date, String(row.amount), row.asset, row.status, String(row.fee)];
      for (let i = 0; i < columns.length; i += 1) {
        doc.text(values[i], x, y, { width: columns[i].width });
        x += columns[i].width;
      }
      y += 16;
    }

    doc.end();
  });
}
