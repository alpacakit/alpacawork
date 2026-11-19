/** Filename classification is a presentation and safe-response policy, never proof of the file's contents. */
export type FileMediaKind = 'image' | 'video' | 'audio' | 'diff';
export type FileFormat = {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly kind: FileMediaKind | null;
  readonly contentType: string;
};

const text = 'text/plain; charset=utf-8';
/** The only extension inventory for managed files. Active markup stays inert text. */
export const FILE_FORMATS: readonly FileFormat[] = [
  { id: 'png', extensions: ['png'], kind: 'image', contentType: 'image/png' },
  { id: 'apng', extensions: ['apng'], kind: 'image', contentType: 'image/apng' },
  { id: 'jpeg', extensions: ['jpg', 'jpeg', 'jfif', 'pjpeg', 'pjp'], kind: 'image', contentType: 'image/jpeg' },
  { id: 'webp', extensions: ['webp'], kind: 'image', contentType: 'image/webp' },
  { id: 'gif', extensions: ['gif'], kind: 'image', contentType: 'image/gif' },
  { id: 'avif', extensions: ['avif'], kind: 'image', contentType: 'image/avif' },
  { id: 'bmp', extensions: ['bmp'], kind: 'image', contentType: 'image/bmp' },
  { id: 'ico', extensions: ['ico'], kind: 'image', contentType: 'image/x-icon' },
  { id: 'webm', extensions: ['webm'], kind: 'video', contentType: 'video/webm' },
  { id: 'mp4', extensions: ['mp4', 'm4v'], kind: 'video', contentType: 'video/mp4' },
  { id: 'mov', extensions: ['mov'], kind: 'video', contentType: 'video/quicktime' },
  { id: 'ogv', extensions: ['ogv'], kind: 'video', contentType: 'video/ogg' },
  { id: 'mp3', extensions: ['mp3'], kind: 'audio', contentType: 'audio/mpeg' },
  { id: 'm4a', extensions: ['m4a'], kind: 'audio', contentType: 'audio/mp4' },
  { id: 'aac', extensions: ['aac'], kind: 'audio', contentType: 'audio/aac' },
  { id: 'wav', extensions: ['wav'], kind: 'audio', contentType: 'audio/wav' },
  { id: 'flac', extensions: ['flac'], kind: 'audio', contentType: 'audio/flac' },
  { id: 'ogg', extensions: ['ogg', 'oga', 'opus'], kind: 'audio', contentType: 'audio/ogg' },
  { id: 'diff', extensions: ['diff', 'patch'], kind: 'diff', contentType: text },
  { id: 'json', extensions: ['json'], kind: null, contentType: 'application/json; charset=utf-8' },
  { id: 'csv', extensions: ['csv'], kind: null, contentType: 'text/csv; charset=utf-8' },
  { id: 'tsv', extensions: ['tsv'], kind: null, contentType: 'text/tab-separated-values; charset=utf-8' },
  { id: 'text', extensions: ('txt md markdown mdx log ts tsx mts cts js jsx mjs cjs jsonl ndjson yaml yml toml ini conf ' +
    'html htm xhtml xml svg css scss less py rb go rs java c cc cpp h hpp sh bash sql').split(' '), kind: null, contentType: text },
];

const byExtension = new Map(FILE_FORMATS.flatMap(format => format.extensions.map(extension => [extension, format] as const)));
export function fileFormat(name: string): FileFormat | null {
  return byExtension.get(/\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? '') ?? null;
}
export const fileMediaType = (name: string): string => fileFormat(name)?.contentType ?? 'application/octet-stream';
/** Whether the file's address answers for a tab to show it (inline); a file of no format here is always saved (attachment). */
export const fileInline = (name: string): boolean => fileFormat(name) !== null;
/**
 * Media (an image, a video or a sound) streams at any size from the one file address every screen entry uses: whoever
 * shows it never needs the file's size to choose where it loads. The attachment limit bounds documents read whole.
 */
export const fileStreams = (name: string): boolean => ['image', 'video', 'audio'].includes(fileFormat(name)?.kind ?? '');
