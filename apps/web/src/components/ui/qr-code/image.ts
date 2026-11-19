import { qrcodegen } from './qrcodegen';

type QrImage = { status: 'ready'; size: number; path: string } | { status: 'unavailable'; error: unknown };

/** The caller can inspect failure without an error boundary; the manual URL remains usable. */
export function generateQrCode(value: string): QrImage {
  try {
    const qr = qrcodegen.QrCode.encodeText(value, qrcodegen.QrCode.Ecc.MEDIUM);
    const border = 4;
    const modules: string[] = [];
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) modules.push(`M${x + border},${y + border}h1v1h-1z`);
      }
    }
    return { status: 'ready', size: qr.size + border * 2, path: modules.join('') };
  } catch (error) {
    return { status: 'unavailable', error };
  }
}
