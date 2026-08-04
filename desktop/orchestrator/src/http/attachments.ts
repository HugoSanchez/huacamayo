// Image attachments for chat messages.
//
// The chat-ui posts `attachments: [{ name, mimeType, dataBase64 }]` alongside
// `content`. We validate by magic bytes (the browser-declared MIME type is
// advisory), forward the images to Hermes as `input_image` content parts on
// the live request only, and persist a plain-text marker line per attachment
// inside the stored message content. Markers — not blobs — are what survive
// restarts and history rebuilds, so the transcript always shows that a message
// carried attachments without the DB ever holding image data.

export interface ChatAttachment {
  name: string;
  /** Sniffed from magic bytes, never trusted from the client. */
  mimeType: string;
  dataBase64: string;
}

export const MAX_ATTACHMENT_COUNT = 6;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export class AttachmentValidationError extends Error {}

/** Must stay in sync with the marker parsing in chat-ui (MessageList.tsx). */
export function attachmentMarker(name: string): string {
  return `[attached image: ${name}]`;
}

export function appendAttachmentMarkers(text: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return text;
  const markers = attachments.map((attachment) => attachmentMarker(attachment.name)).join('\n');
  return text ? `${text}\n\n${markers}` : markers;
}

export function parseChatAttachments(body: unknown): ChatAttachment[] {
  const raw = (body as { attachments?: unknown } | null)?.attachments;
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new AttachmentValidationError('"attachments" must be an array');
  }
  if (raw.length > MAX_ATTACHMENT_COUNT) {
    throw new AttachmentValidationError(`Too many attachments (max ${MAX_ATTACHMENT_COUNT})`);
  }

  let totalBytes = 0;
  const attachments: ChatAttachment[] = [];
  for (const entry of raw) {
    const record = entry as { name?: unknown; dataBase64?: unknown } | null;
    const dataBase64 = typeof record?.dataBase64 === 'string' ? record.dataBase64 : '';
    if (!dataBase64) {
      throw new AttachmentValidationError('Each attachment needs base64 image data');
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(dataBase64, 'base64');
    } catch {
      throw new AttachmentValidationError('Attachment data is not valid base64');
    }
    if (bytes.length === 0) {
      throw new AttachmentValidationError('Attachment data is not valid base64');
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        `Attachment exceeds ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB limit`,
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        `Attachments exceed ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024))}MB total limit`,
      );
    }

    const mimeType = sniffImageMime(bytes);
    if (!mimeType) {
      throw new AttachmentValidationError('Only PNG, JPEG, WebP, and GIF images are supported');
    }

    attachments.push({
      name: sanitizeAttachmentName(record?.name),
      mimeType,
      dataBase64,
    });
  }

  return attachments;
}

// Marker lines use square brackets, so strip them (plus control chars) from
// names to keep the stored marker parseable.
function sanitizeAttachmentName(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const cleaned = raw.replace(/[[\]\p{Cc}]/gu, '').trim().slice(0, 120);
  return cleaned || 'image';
}

function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12
    && bytes.toString('latin1', 0, 4) === 'RIFF'
    && bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'GIF8') {
    return 'image/gif';
  }
  return null;
}
