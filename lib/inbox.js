import { SEEN_CAP } from './config.js';

// Decides which messages deserve a notification. An account with no history yet
// (just connected, or its folders just changed) sets a baseline silently, so the
// existing backlog does not trigger a flood.
export function diffNewMessages(messages, seenIds) {
  if (!seenIds) return [];
  const seen = new Set(seenIds);
  return messages.filter((m) => !seen.has(m.id));
}

export function updateSeen(messages, seenIds = []) {
  const merged = [...new Set([...messages.map((m) => m.id), ...seenIds])];
  return merged.slice(0, SEEN_CAP);
}

export function totalUnread(inbox) {
  return Object.values(inbox?.byAccount || {}).reduce((sum, a) => sum + a.messages.length, 0);
}

export function badgeText(inbox) {
  const accounts = Object.values(inbox?.byAccount || {});
  const total = totalUnread(inbox);
  if (total === 0) return accounts.some((a) => a.error) ? '!' : '';
  return accounts.some((a) => a.capped) ? `${total}+` : String(total);
}

export function decodeEntities(text) {
  if (!text || !text.includes('&')) return text || '';
  return new DOMParser().parseFromString(text, 'text/html').documentElement.textContent;
}

export function replySubject(subject) {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}
