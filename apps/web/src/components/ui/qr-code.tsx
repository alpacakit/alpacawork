import { useMemo } from 'react';
import { generateQrCode } from './qr-code/image';

export { generateQrCode } from './qr-code/image';

/** Local SVG, with its own white quiet zone even inside a dark screen. Unencodable input renders nothing. */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const image = useMemo(() => generateQrCode(value), [value]);
  if (image.status === 'unavailable') return null;
  // Four whole pixels per module avoids losing dense codes to a caller's small CSS size.
  const pixels = image.size * 4;
  return <svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label={label} className={className}
    width={pixels} height={pixels} style={{ minWidth: pixels, minHeight: pixels }}
    viewBox={`0 0 ${image.size} ${image.size}`} shapeRendering="crispEdges">
    <rect width={image.size} height={image.size} fill="#fff" />
    <path d={image.path} fill="#000" />
  </svg>;
}
