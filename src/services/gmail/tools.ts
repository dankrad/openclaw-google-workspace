/**
 * Gmail tool definitions.
 * 5 tools: search, read, list_unread, list_by_label, send
 */

import type { ResolvedWorkspaceConfig } from "../../config/schema.js";
import { createAuthService } from "../../auth/google-auth.js";
import { createGmailClient } from "./client.js";
import {
  textResult,
  errorResult,
  formatEmailSummary,
  formatEmailList,
  type ToolResult,
} from "../../shared/formatting.js";
import { ReadOnlyModeError } from "../../shared/errors.js";
import { normalizeGoogleError } from "../../shared/google-error.js";

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<ToolResult>;
}

async function getGmailClient(config: ResolvedWorkspaceConfig) {
  const auth = createAuthService(config);
  const oauth = await auth.createAuthenticatedClient();
  return createGmailClient(oauth);
}

export function buildGmailTools(
  config: ResolvedWorkspaceConfig,
): ToolDefinition[] {
  const gmailConfig = config.services.gmail;

  return [
    {
      name: "google_gmail_search",
      label: "Search Gmail",
      description:
        "Search Gmail messages using Gmail search syntax (e.g., 'from:boss@company.com', 'subject:invoice', 'is:unread newer_than:2d').",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Gmail search query using Gmail search syntax.",
          },
          maxResults: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 20,
            description: "Maximum number of results to return.",
          },
        },
      },
      execute: async (_id, params) => {
        try {
          const client = await getGmailClient(config);
          const query = params.query as string;
          const maxResults =
            (params.maxResults as number) ?? gmailConfig.maxSearchResults;
          const messages = await client.searchMessages(query, maxResults);
          return textResult(formatEmailList(messages));
        } catch (error) {
          return errorResult(normalizeGoogleError(error, "Gmail", "search messages"));
        }
      },
    },

    {
      name: "google_gmail_read",
      label: "Read Gmail Message",
      description:
        "Read a specific Gmail message by its ID. Returns full message content including body text.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["messageId"],
        properties: {
          messageId: {
            type: "string",
            description: "The Gmail message ID to read.",
          },
        },
      },
      execute: async (_id, params) => {
        try {
          const client = await getGmailClient(config);
          const messageId = params.messageId as string;
          const message = await client.getMessage(messageId);
          return textResult(formatEmailSummary(message));
        } catch (error) {
          return errorResult(normalizeGoogleError(error, "Gmail", "read message"));
        }
      },
    },

    {
      name: "google_gmail_list_unread",
      label: "List Unread Gmail",
      description:
        "List unread messages in the Gmail inbox. Returns subject, sender, date, and snippet for each message.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxResults: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 20,
            description: "Maximum number of unread messages to return.",
          },
        },
      },
      execute: async (_id, params) => {
        try {
          const client = await getGmailClient(config);
          const maxResults =
            (params.maxResults as number) ?? gmailConfig.maxSearchResults;
          const messages = await client.listUnread(maxResults);
          return textResult(formatEmailList(messages));
        } catch (error) {
          return errorResult(normalizeGoogleError(error, "Gmail", "list unread messages"));
        }
      },
    },

    {
      name: "google_gmail_list_by_label",
      label: "List Gmail by Label",
      description:
        "List Gmail messages by label name (e.g., 'INBOX', 'SENT', 'STARRED', or custom labels).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["label"],
        properties: {
          label: {
            type: "string",
            description:
              "Label name to filter by (e.g., 'INBOX', 'SENT', 'STARRED', 'IMPORTANT', or a custom label).",
          },
          maxResults: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 20,
            description: "Maximum number of messages to return.",
          },
        },
      },
      execute: async (_id, params) => {
        try {
          const client = await getGmailClient(config);
          const label = params.label as string;
          const maxResults =
            (params.maxResults as number) ?? gmailConfig.maxSearchResults;
          const messages = await client.listByLabel(label, maxResults);
          return textResult(formatEmailList(messages));
        } catch (error) {
          return errorResult(normalizeGoogleError(error, "Gmail", "list messages by label"));
        }
      },
    },

    {
      name: "google_gmail_send",
      label: "Send Gmail",
      description:
        "Compose and send an email via Gmail. Blocked in read-only mode.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["to", "subject", "body"],
        properties: {
          to: {
            type: "string",
            description: "Recipient email address.",
          },
          subject: {
            type: "string",
            description: "Email subject line.",
          },
          body: {
            type: "string",
            description: "Email body text (plain text).",
          },
          cc: {
            type: "string",
            description: "CC recipients (comma-separated email addresses).",
          },
          bcc: {
            type: "string",
            description: "BCC recipients (comma-separated email addresses).",
          },
        },
      },
      execute: async (_id, params) => {
        if (gmailConfig.readOnly) {
          return errorResult(new ReadOnlyModeError("gmail", "send email"));
        }
        try {
          const client = await getGmailClient(config);
          const result = await client.sendEmail({
            to: params.to as string,
            subject: params.subject as string,
            body: params.body as string,
            cc: params.cc as string | undefined,
            bcc: params.bcc as string | undefined,
          });
          return textResult(
            `Email sent successfully.\nMessage ID: ${result.id}\nThread ID: ${result.threadId}`,
          );
        } catch (error) {
          return errorResult(normalizeGoogleError(error, "Gmail", "send email"));
        }
      },
    },

    {
      name: "google_gmail_get_attachment",
      label: "Get Gmail Attachment",
      description:
        "Download an email attachment by message ID and attachment ID (both are listed by google_gmail_read). Saves the file under the configured downloads directory and returns the saved path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["messageId", "attachmentId", "filename"],
        properties: {
          messageId: {
            type: "string",
            description: "The Gmail message ID that contains the attachment.",
          },
          attachmentId: {
            type: "string",
            description: "The attachment ID (from google_gmail_read output).",
          },
          filename: {
            type: "string",
            description:
              "Filename to save as (from google_gmail_read output). Sanitized to a safe basename.",
          },
        },
      },
      execute: async (_id, params) => {
        try {
          const MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap
          const client = await getGmailClient(config);
          const messageId = String(params.messageId);
          const attachmentId = String(params.attachmentId);
          const filename = String(params.filename)
            .split(/[/\\]/)
            .pop()! // basename only — no path traversal
            .replace(/[\x00-\x1f]/g, "")
            .trim() || "attachment.bin";

          const buf = await client.getAttachment(messageId, attachmentId);
          if (buf.length > MAX_BYTES) {
            return errorResult(
              `Attachment too large: ${buf.length} bytes (max ${MAX_BYTES}).`,
            );
          }

          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const os = await import("node:os");
          const dir = path.resolve(
            config.downloadsDir ?? path.join(os.homedir(), "downloads"),
          );
          await fs.mkdir(dir, { recursive: true });
          const filePath = path.join(dir, filename);
          await fs.writeFile(filePath, buf);
          return textResult(
            `Attachment saved: ${filePath} (${buf.length} bytes, ${params.filename}).`,
          );
        } catch (error) {
          return errorResult(
            normalizeGoogleError(error, "Gmail", "get attachment"),
          );
        }
      },
    },
  ];
}
