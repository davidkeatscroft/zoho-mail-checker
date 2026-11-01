// Zoho data centres. A mailbox lives in exactly one, and its tokens only work there.
export const REGIONS = {
  us: { label: 'United States (zoho.com)', accounts: 'https://accounts.zoho.com', mail: 'https://mail.zoho.com', console: 'https://api-console.zoho.com' },
  eu: { label: 'Europe (zoho.eu)', accounts: 'https://accounts.zoho.eu', mail: 'https://mail.zoho.eu', console: 'https://api-console.zoho.eu' },
  in: { label: 'India (zoho.in)', accounts: 'https://accounts.zoho.in', mail: 'https://mail.zoho.in', console: 'https://api-console.zoho.in' },
  au: { label: 'Australia (zoho.com.au)', accounts: 'https://accounts.zoho.com.au', mail: 'https://mail.zoho.com.au', console: 'https://api-console.zoho.com.au' },
  jp: { label: 'Japan (zoho.jp)', accounts: 'https://accounts.zoho.jp', mail: 'https://mail.zoho.jp', console: 'https://api-console.zoho.jp' },
  ca: { label: 'Canada (zohocloud.ca)', accounts: 'https://accounts.zohocloud.ca', mail: 'https://mail.zohocloud.ca', console: 'https://api-console.zohocloud.ca' },
  cn: { label: 'China (zoho.com.cn)', accounts: 'https://accounts.zoho.com.cn', mail: 'https://mail.zoho.com.cn', console: 'https://api-console.zoho.com.cn' },
  ae: { label: 'United Arab Emirates (zoho.ae)', accounts: 'https://accounts.zoho.ae', mail: 'https://mail.zoho.ae', console: 'https://api-console.zoho.ae' },
  sa: { label: 'Saudi Arabia (zoho.sa)', accounts: 'https://accounts.zoho.sa', mail: 'https://mail.zoho.sa', console: 'https://api-console.zoho.sa' },
};

export const SCOPES = ['ZohoMail.accounts.READ', 'ZohoMail.folders.READ', 'ZohoMail.messages.ALL'].join(',');

export const DEFAULT_SETTINGS = {
  clientId: '',
  clientSecret: '',
  region: 'us',
  pollMinutes: 2,
  notify: true,
  notifyPreview: true,
  sound: true,
  markReadOnOpen: false,
  loadRemoteImages: false,
};

export const POLL_ALARM = 'poll';
export const PAGE_SIZE = 200;
// Unread counts are found by listing, so very large backlogs are capped and shown as "400+".
export const UNREAD_CAP = 400;
export const MAX_INDIVIDUAL_NOTIFICATIONS = 3;
export const SEEN_CAP = 2000;

// Zoho tells us which data centre a login belongs to. Only trust hosts we know,
// because the client secret is sent to whichever host this returns.
export function regionFromRedirect(accountsServer, location, fallback) {
  if (accountsServer) {
    const match = Object.keys(REGIONS).find((id) => REGIONS[id].accounts === accountsServer.replace(/\/+$/, ''));
    if (match) return match;
    throw new Error(`Zoho returned an unrecognised sign-in server: ${accountsServer}`);
  }
  if (location && REGIONS[location]) return location;
  return fallback;
}
