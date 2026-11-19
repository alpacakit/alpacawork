# QR encoder

Vendored from Project Nayuki QR Code generator, MIT license (see LICENSE and source header).

- Fixed release: v1.8.0
- Commit: 720f62bddb7226106071d4728c292cb1df519ceb
- Source: https://github.com/nayuki/QR-Code-generator/blob/720f62bddb7226106071d4728c292cb1df519ceb/typescript-javascript/qrcodegen.ts
- Project: https://www.nayuki.io/page/qr-code-generator-library
- Local changes: `@ts-nocheck` for the upstream array accesses under this repo's `noUncheckedIndexedAccess`; ES-module namespace export. Encoding algorithm is unchanged.

The encoder has no runtime dependencies and does not send input over the network. The upstream file is kept intact apart from the two module integration additions. `image.ts` only converts its module grid to an SVG path with a four-module quiet zone.

`QrCode` renders nothing if encoding fails. `generateQrCode(value)` exposes the same discriminated ready/unavailable result to callers that need a failure message. Always keep the manual URL alongside the image. The server's public-host pattern currently has no length bound; oversized URLs can exceed QR capacity, while a 253-character DNS hostname fits.

The SVG enforces a minimum four CSS pixels per module including its quiet zone. Dense codes grow rather than becoming unreadable under a small size class.
