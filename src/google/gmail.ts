import { googleJson } from "./auth.js";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface MessageHeader {
  name: string;
  value: string;
}

export interface MessageSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

interface MessagePart {
  mimeType: string;
  filename?: string;
  headers?: MessageHeader[];
  body: { size: number; data?: string; attachmentId?: string };
  parts?: MessagePart[];
}

export async function searchEmails(
  token: string,
  query: string,
  maxResults = 10,
): Promise<MessageSummary[]> {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(Math.min(Math.max(maxResults, 1), 50)),
  });
  const listBody = await googleJson<{ messages?: { id: string; threadId: string }[] }>(
    token,
    `${GMAIL_BASE}/messages?${params}`,
  );
  if (!listBody.messages?.length) return [];

  const summaries: MessageSummary[] = [];
  for (const msg of listBody.messages) {
    const meta = await googleJson<{
      id: string;
      threadId: string;
      snippet: string;
      payload: { headers: MessageHeader[] };
    }>(
      token,
      `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
    );
    const header = (name: string) =>
      meta.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
      "";
    summaries.push({
      id: meta.id,
      threadId: meta.threadId,
      subject: header("Subject"),
      from: header("From"),
      date: header("Date"),
      snippet: meta.snippet,
    });
  }
  return summaries;
}

export async function getEmail(token: string, messageId: string) {
  const msg = await googleJson<{
    id: string;
    threadId: string;
    labelIds?: string[];
    payload: MessagePart;
  }>(token, `${GMAIL_BASE}/messages/${messageId}?format=full`);

  const header = (name: string) =>
    msg.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    subject: header("Subject"),
    from: header("From"),
    to: header("To"),
    date: header("Date"),
    body: extractBody(msg.payload),
    attachments: extractAttachments(msg.payload),
  };
}

export async function getThread(token: string, threadId: string) {
  const thread = await googleJson<{
    id: string;
    messages?: Array<{
      id: string;
      labelIds?: string[];
      snippet?: string;
      payload: MessagePart;
    }>;
  }>(token, `${GMAIL_BASE}/threads/${threadId}?format=full`);

  return {
    id: thread.id,
    messages: (thread.messages ?? []).map((msg) => {
      const header = (name: string) =>
        msg.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
        "";
      return {
        id: msg.id,
        labelIds: msg.labelIds ?? [],
        subject: header("Subject"),
        from: header("From"),
        to: header("To"),
        date: header("Date"),
        snippet: msg.snippet ?? "",
        body: extractBody(msg.payload),
      };
    }),
  };
}

export async function listLabels(token: string) {
  const body = await googleJson<{ labels?: { id: string; name: string; type: string }[] }>(
    token,
    `${GMAIL_BASE}/labels`,
  );
  return body.labels ?? [];
}

export async function modifyLabels(
  token: string,
  messageId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
) {
  await googleJson(token, `${GMAIL_BASE}/messages/${messageId}/modify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
}

export async function trashEmail(token: string, messageId: string) {
  await googleJson(token, `${GMAIL_BASE}/messages/${messageId}/trash`, { method: "POST" });
}

export async function createDraft(token: string, rawMime: string) {
  const result = await googleJson<{ id: string }>(token, `${GMAIL_BASE}/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw: rawMime } }),
  });
  return result.id;
}

export async function sendEmail(token: string, rawMime: string) {
  const result = await googleJson<{ id: string }>(token, `${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw: rawMime }),
  });
  return result.id;
}

export function buildMimeMessage(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  validateEmail(opts.to);
  if (opts.cc) validateEmail(opts.cc);

  const lines = [
    `To: ${sanitizeHeader(opts.to)}`,
    `Subject: ${sanitizeHeader(opts.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
  ];
  if (opts.cc) lines.splice(1, 0, `Cc: ${sanitizeHeader(opts.cc)}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${sanitizeHeader(opts.inReplyTo)}`);
  if (opts.references) lines.push(`References: ${sanitizeHeader(opts.references)}`);
  lines.push("", opts.body);

  const base64 = btoa(unescape(encodeURIComponent(lines.join("\r\n"))));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function extractBody(part: MessagePart): string {
  if (part.body?.data && part.mimeType === "text/plain") {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    for (const p of part.parts) {
      if (p.mimeType === "text/plain" && p.body?.data) return decodeBase64Url(p.body.data);
    }
    for (const p of part.parts) {
      if (p.mimeType === "text/html" && p.body?.data) return decodeBase64Url(p.body.data);
    }
    for (const p of part.parts) {
      const nested = extractBody(p);
      if (nested) return nested;
    }
  }
  if (part.body?.data && part.mimeType === "text/html") {
    return decodeBase64Url(part.body.data);
  }
  return "";
}

function extractAttachments(part: MessagePart) {
  const attachments: { filename: string; mimeType: string; size: number }[] = [];
  function walk(p: MessagePart) {
    if (p.filename && p.body) {
      attachments.push({
        filename: p.filename,
        mimeType: p.mimeType,
        size: p.body.size,
      });
    }
    for (const child of p.parts ?? []) walk(child);
  }
  walk(part);
  return attachments;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeURIComponent(
      Array.from(atob(base64), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(
        "",
      ),
    );
  } catch {
    return atob(base64);
  }
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

function validateEmail(email: string): void {
  const addr = email.includes("<") ? (email.match(/<([^>]+)>/)?.[1] ?? email) : email;
  if (!EMAIL_REGEX.test(addr.trim())) {
    throw new Error(`Invalid email address: ${email}`);
  }
}
