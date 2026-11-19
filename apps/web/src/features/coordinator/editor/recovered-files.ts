import { withRequestActivity } from '@/data/request-activity';
import { uploadAttachment, type AttachmentDestination } from '@/data/attachments';
import { attachmentLocation, attachmentsOf } from '@/domain/attachments';
import { ApiError } from '@/data/client';
/** A retry is a new request. Copy its retained attachments; never move files out of an already accepted message. */
export async function copyRecoveredFiles(values: Record<string, string>, conversationId: string, requestId: string) {
    const files = attachmentsOf(values);
    if (!files.length)
        return;
    const operations = JSON.parse(values.readerCopies ?? '{}') as Record<string, string>;
    const destination: AttachmentDestination = { kind: 'coordinator', conversationId };
    const names: string[] = [];
    for (const file of files) {
        const source = attachmentLocation(file);
        if (source.requestId === requestId) { names.push(source.name); continue; }
        const operation = operations[file.path];
        if (!operation) throw new ApiError('Missing retained attachment copy operation', 'invalid_response', 'fix');
        const bytes = await withRequestActivity(async () => {
            const response = await fetch(file.absolutePath);
            if (!response.ok)
                throw new ApiError('Cannot read the retained attachment', 'not_found', 'fix');
            return response.blob();
        });
        const copied = await uploadAttachment(destination, requestId, new File([bytes], file.name, { type: bytes.type }), source.name, () => { }, new AbortController().signal, operation);
        names.push(attachmentLocation(copied).name);
    }
    return names;
}
