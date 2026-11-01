import { PAGE_SIZE, UNREAD_CAP } from './config.js';

export class ZohoError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
  get isAuthError() {
    return this.status === 401 || this.code === 'INVALID_OAUTHTOKEN';
  }
}

// Zoho IDs are 64-bit and lose digits as JS numbers, so quote them before parsing.
export function parseJsonKeepingIds(text) {
  return JSON.parse(text.replace(/("[\w-]+"\s*:\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
}

// Builds {"mode":..,"messageId":[1,2]} with the IDs as bare integers, as Zoho documents.
export function updateMessageBody(mode, messageIds) {
  for (const id of messageIds) {
    if (!/^\d+$/.test(id)) throw new Error(`Invalid message ID: ${id}`);
  }
  return `{"mode":${JSON.stringify(mode)},"messageId":[${messageIds.join(',')}]}`;
}

export async function request({ mailOrigin, accessToken }, method, path, { query, body } = {}) {
  const url = new URL(`/api${path}`, mailOrigin);
  if (query) url.search = new URLSearchParams(query);
  const response = await fetch(url.href, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? parseJsonKeepingIds(text) : null;
  } catch {
    // Handled below: errors can come back as HTML, and a success with no JSON has no data.
  }
  if (!response.ok) {
    const description = parsed?.data?.moreInfo || parsed?.status?.description || `HTTP ${response.status}`;
    throw new ZohoError(`Zoho Mail: ${description}`, response.status, parsed?.data?.errorCode);
  }
  return parsed?.data;
}

export function normalizeAccount(raw) {
  return {
    accountId: String(raw.accountId),
    email: raw.primaryEmailAddress || raw.mailboxAddress || raw.emailAddress?.[0]?.mailId || '',
    displayName: raw.displayName || '',
  };
}

export function normalizeFolder(raw) {
  return { id: String(raw.folderId), name: raw.folderName, type: raw.folderType, path: raw.path || raw.folderName };
}

export function normalizeMessage(raw, accountId) {
  return {
    id: String(raw.messageId),
    accountId,
    folderId: String(raw.folderId),
    subject: raw.subject || '',
    sender: raw.sender || '',
    fromAddress: raw.fromAddress || '',
    summary: raw.summary || '',
    receivedTime: Number(raw.receivedTime) || 0,
    hasAttachment: String(raw.hasAttachment) === '1' || raw.hasAttachment === true,
  };
}

export async function listUnread(session, accountId, folderIds) {
  const byId = new Map();
  let capped = false;
  for (const folderId of folderIds) {
    let start = 1;
    while (true) {
      const page = (await request(session, 'GET', `/accounts/${accountId}/messages/view`, {
        query: { folderId, status: 'unread', start, limit: PAGE_SIZE, sortorder: false },
      })) || [];
      for (const raw of page) byId.set(String(raw.messageId), normalizeMessage(raw, accountId));
      if (page.length < PAGE_SIZE) break;
      if (byId.size >= UNREAD_CAP) {
        capped = true;
        break;
      }
      start += PAGE_SIZE;
    }
  }
  const messages = [...byId.values()].sort((a, b) => b.receivedTime - a.receivedTime);
  return { messages, capped };
}

export function extractEmail(value) {
  const match = /<([^<>\s]+@[^<>\s]+)>/.exec(value) || /[^\s<>"',;]+@[^\s<>"',;]+/.exec(value);
  return match ? match[1] || match[0] : '';
}

// Pulls the Reply-To address out of a raw header block, unfolding continuation lines.
export function replyToFromHeaders(headers) {
  if (typeof headers !== 'string') return '';
  const line = headers.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).find((l) => /^reply-to:/i.test(l));
  return line ? extractEmail(line) : '';
}
