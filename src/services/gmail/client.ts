/**
 * Gmail API client wrapper.
 * Provides typed methods for common Gmail operations.
 */

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";

export interface EmailAttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface EmailMessage {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  body?: string;
  labelIds?: string[];
  attachments?: EmailAttachmentMeta[];
}

export interface GmailClient {
  searchMessages(query: string, maxResults: number): Promise<EmailMessage[]>;
  getMessage(messageId: string): Promise<EmailMessage>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  listUnread(maxResults: number): Promise<EmailMessage[]>;
  listByLabel(label: string, maxResults: number): Promise<EmailMessage[]>;
  sendEmail(params: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
  }): Promise<{ id: string; threadId: string }>;
}

function parseHeaders(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};
  if (!headers) return map;
  for (const h of headers) {
    if (h.name && h.value) {
      map[h.name.toLowerCase()] = h.value;
    }
  }
  return map;
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  // Simple text/plain body
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  // Multipart — look for text/plain first, then text/html
  if (payload.parts) {
    const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, "base64url").toString("utf-8");
    }

    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
      // Strip HTML tags for a rough plaintext version
      return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    }

    // Recurse into nested multipart
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return "";
}

function extractAttachments(payload?: gmail_v1.Schema$MessagePart): EmailAttachmentMeta[] {
  const out: EmailAttachmentMeta[] = [];
  const walk = (part?: gmail_v1.Schema$MessagePart): void => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      out.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        sizeBytes: part.body.size ?? 0,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

function messageToEmail(msg: gmail_v1.Schema$Message): EmailMessage {
  const headers = parseHeaders(msg.payload?.headers);
  return {
    id: msg.id!,
    threadId: msg.threadId ?? undefined,
    from: headers["from"],
    to: headers["to"],
    cc: headers["cc"],
    subject: headers["subject"],
    date: headers["date"],
    snippet: msg.snippet ?? undefined,
    body: extractBody(msg.payload),
    labelIds: msg.labelIds ?? undefined,
    attachments: extractAttachments(msg.payload),
  };
}

function messageSummary(msg: gmail_v1.Schema$Message): EmailMessage {
  const headers = parseHeaders(msg.payload?.headers);
  return {
    id: msg.id!,
    threadId: msg.threadId ?? undefined,
    from: headers["from"],
    subject: headers["subject"],
    date: headers["date"],
    snippet: msg.snippet ?? undefined,
  };
}

function buildMimeMessage(params: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): string {
  const lines: string[] = [];
  lines.push(`To: ${params.to}`);
  if (params.cc) lines.push(`Cc: ${params.cc}`);
  if (params.bcc) lines.push(`Bcc: ${params.bcc}`);
  lines.push(`Subject: ${params.subject}`);
  lines.push("Content-Type: text/plain; charset=utf-8");
  lines.push("MIME-Version: 1.0");
  lines.push("");
  lines.push(params.body);
  return lines.join("\r\n");
}

export function createGmailClient(auth: OAuth2Client): GmailClient {
  const gmail = google.gmail({ version: "v1", auth });

  return {
    async searchMessages(query, maxResults) {
      const res = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults,
      });

      const messageIds = res.data.messages ?? [];
      if (messageIds.length === 0) return [];

      // Fetch each message with metadata
      const messages = await Promise.all(
        messageIds.slice(0, maxResults).map(async (m) => {
          const full = await gmail.users.messages.get({
            userId: "me",
            id: m.id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date", "Cc"],
          });
          return messageSummary(full.data);
        }),
      );

      return messages;
    },

    async getMessage(messageId) {
      const res = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });
      return messageToEmail(res.data);
    },

    async getAttachment(messageId, attachmentId) {
      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      });
      return Buffer.from(res.data.data ?? "", "base64url");
    },

    async listUnread(maxResults) {
      return this.searchMessages("is:unread in:inbox", maxResults);
    },

    async listByLabel(label, maxResults) {
      // Try to find the label ID first
      const labelsRes = await gmail.users.labels.list({ userId: "me" });
      const labels = labelsRes.data.labels ?? [];
      const match = labels.find(
        (l) => l.name?.toLowerCase() === label.toLowerCase(),
      );

      if (match?.id) {
        const res = await gmail.users.messages.list({
          userId: "me",
          labelIds: [match.id],
          maxResults,
        });

        const messageIds = res.data.messages ?? [];
        if (messageIds.length === 0) return [];

        const messages = await Promise.all(
          messageIds.slice(0, maxResults).map(async (m) => {
            const full = await gmail.users.messages.get({
              userId: "me",
              id: m.id!,
              format: "metadata",
              metadataHeaders: ["From", "To", "Subject", "Date"],
            });
            return messageSummary(full.data);
          }),
        );
        return messages;
      }

      // Fallback to search
      return this.searchMessages(`label:${label}`, maxResults);
    },

    async sendEmail(params) {
      const raw = buildMimeMessage(params);
      const encoded = Buffer.from(raw)
        .toString("base64url");

      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: encoded },
      });

      return {
        id: res.data.id!,
        threadId: res.data.threadId!,
      };
    },
  };
}
