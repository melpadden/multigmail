import { googleJson } from "./auth.js";
import { truncateText } from "../auth/utils.js";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,createdTime,owners(emailAddress,displayName),webViewLink,iconLink,size,parents,shared,trashed";

export async function searchFiles(
  token: string,
  opts: { query?: string; q?: string; maxResults?: number },
) {
  let q = opts.q?.trim() || "";
  if (!q && opts.query?.trim()) {
    const escaped = opts.query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    q = `fullText contains '${escaped}' and trashed = false`;
  }
  if (!q) q = "trashed = false";

  const params = new URLSearchParams({
    q,
    pageSize: String(Math.min(Math.max(opts.maxResults ?? 20, 1), 50)),
    fields: `files(${FILE_FIELDS})`,
    spaces: "drive",
  });

  const body = await googleJson<{ files?: Record<string, unknown>[] }>(
    token,
    `${DRIVE_BASE}/files?${params}`,
  );
  return body.files ?? [];
}

export async function getFile(
  token: string,
  fileId: string,
  includeContent = false,
) {
  const meta = await googleJson<Record<string, unknown>>(
    token,
    `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`,
  );

  if (!includeContent) return { ...meta, content: undefined };

  const mimeType = String(meta.mimeType ?? "");
  let content: string | undefined;

  if (mimeType.startsWith("application/vnd.google-apps.")) {
    const exportMime =
      mimeType === "application/vnd.google-apps.document"
        ? "text/plain"
        : mimeType === "application/vnd.google-apps.spreadsheet"
          ? "text/csv"
          : mimeType === "application/vnd.google-apps.presentation"
            ? "text/plain"
            : null;
    if (exportMime) {
      const resp = await fetch(
        `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (resp.ok) {
        content = truncateText(await resp.text(), 80_000);
      }
    }
  } else if (mimeType.startsWith("text/") || mimeType === "application/json") {
    const resp = await fetch(
      `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (resp.ok) {
      content = truncateText(await resp.text(), 80_000);
    }
  }

  return { ...meta, content };
}

export async function listFolder(token: string, folderId = "root", maxResults = 50) {
  const parent = folderId === "root" ? "root" : folderId;
  const q = `'${parent.replace(/'/g, "\\'")}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q,
    pageSize: String(Math.min(Math.max(maxResults, 1), 100)),
    fields: `files(${FILE_FIELDS})`,
    orderBy: "folder,name",
  });
  const body = await googleJson<{ files?: Record<string, unknown>[] }>(
    token,
    `${DRIVE_BASE}/files?${params}`,
  );
  return body.files ?? [];
}

export async function createFolder(token: string, name: string, parentId?: string) {
  const body: Record<string, unknown> = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) body.parents = [parentId];

  return googleJson(token, `${DRIVE_BASE}/files?fields=${FILE_FIELDS}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function trashFile(token: string, fileId: string) {
  return googleJson(token, `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
}
