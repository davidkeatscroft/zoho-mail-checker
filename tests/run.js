import { REGIONS, regionFromRedirect } from '../lib/config.js';
import { extractEmail, parseJsonKeepingIds, replyToFromHeaders, updateMessageBody } from '../lib/zoho.js';
import { badgeText, decodeEntities, diffNewMessages, replySubject, updateSeen } from '../lib/inbox.js';
import { buildEmailDocument, isSafeExternalLink } from '../lib/email-frame.js';
import { DND_ALARM, dndEnd, dndStatus, isDndOn } from '../lib/dnd.js';
import { ACCOUNT_ID, INBOX_ID, createMock, message } from './mock-zoho.js';

const results = [];
const send = (type, payload) => browser.runtime.sendMessage({ type, ...payload });

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || 'value'}: expected ${e}, got ${a}`);
}
function assertTrue(value, label) {
  if (!value) throw new Error(`${label || 'value'} was falsy`);
}
async function assertRejects(promise, pattern) {
  let error = null;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error('expected a rejection');
  if (pattern && !pattern.test(error.message)) throw new Error(`wrong error: ${error.message}`);
}
async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
  }
}

// ---- Unit tests ----

await test('64-bit IDs survive JSON parsing', () => {
  const parsed = parseJsonKeepingIds('{"messageId":1709876190693100009,"n":5,"list":[{"folderId": 1709876190693100001 }],"text":"\\"messageId\\":1709876190693100009"}');
  assertEqual(parsed.messageId, '1709876190693100009');
  assertEqual(parsed.n, 5);
  assertEqual(parsed.list[0].folderId, '1709876190693100001');
  assertEqual(parsed.text, '"messageId":1709876190693100009');
});

await test('update bodies send bare integer IDs and refuse anything else', () => {
  assertEqual(updateMessageBody('archiveMails', ['1709876190693100009']), '{"mode":"archiveMails","messageId":[1709876190693100009]}');
  let threw = false;
  try {
    updateMessageBody('archiveMails', ['1],"mode":"x']);
  } catch {
    threw = true;
  }
  assertTrue(threw, 'rejected injected ID');
});

await test('email addresses are extracted from display forms', () => {
  assertEqual(extractEmail('Jo Bloggs <jo@example.com>'), 'jo@example.com');
  assertEqual(extractEmail('jo@example.com'), 'jo@example.com');
  assertEqual(extractEmail('"Jo" jo@example.com, other'), 'jo@example.com');
  assertEqual(extractEmail('no address'), '');
});

await test('Reply-To is read from folded headers', () => {
  assertEqual(replyToFromHeaders('From: a@b.com\r\nReply-To: Team\r\n <team@b.com>\r\nX: y'), 'team@b.com');
  assertEqual(replyToFromHeaders('From: a@b.com'), '');
  assertEqual(replyToFromHeaders(undefined), '');
});

await test('notification diff stays silent on the first baseline', () => {
  const msgs = [{ id: '1' }, { id: '2' }];
  assertEqual(diffNewMessages(msgs, undefined), []);
  assertEqual(diffNewMessages(msgs, ['1']).map((m) => m.id), ['2']);
  assertEqual(updateSeen(msgs, ['1', '0']), ['1', '2', '0']);
});

await test('badge text reflects count, cap and errors', () => {
  assertEqual(badgeText({ byAccount: {} }), '');
  assertEqual(badgeText({ byAccount: { a: { messages: [{}, {}] } } }), '2');
  assertEqual(badgeText({ byAccount: { a: { messages: [{}], capped: true } } }), '1+');
  assertEqual(badgeText({ byAccount: { a: { messages: [], error: 'x' } } }), '!');
});

await test('text helpers', () => {
  assertEqual(decodeEntities('Tom &amp; Jerry &lt;x&gt;'), 'Tom & Jerry <x>');
  assertEqual(decodeEntities('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  assertEqual(replySubject('Hi'), 'Re: Hi');
  assertEqual(replySubject('RE: Hi'), 'RE: Hi');
});

await test('only known Zoho sign-in servers are trusted', () => {
  assertEqual(regionFromRedirect('https://accounts.zoho.eu', 'eu', 'us'), 'eu');
  assertEqual(regionFromRedirect('https://accounts.zohocloud.ca/', null, 'us'), 'ca');
  assertEqual(regionFromRedirect(null, 'in', 'us'), 'in');
  assertEqual(regionFromRedirect(null, null, 'us'), 'us');
  let threw = false;
  try {
    regionFromRedirect('https://accounts.zoho.evil.example', 'us', 'us');
  } catch {
    threw = true;
  }
  assertTrue(threw, 'rejected unknown host');
});

await test('email HTML has active content stripped', () => {
  const { srcdoc, hasRemote } = buildEmailDocument('<script>x()</script><img src="https://t.example/p.gif" onerror="x()"><a href="javascript:x()">l</a><form action="https://e.example"><input></form><meta http-equiv="refresh" content="0;url=https://e.example">');
  assertTrue(!/<script>x/.test(srcdoc), 'script');
  assertTrue(!/onerror/.test(srcdoc), 'handler');
  assertTrue(!/javascript:/.test(srcdoc), 'js url');
  assertTrue(!/<form/.test(srcdoc), 'form');
  assertTrue(!/refresh/.test(srcdoc), 'refresh');
  assertTrue(hasRemote, 'remote detected');
  assertTrue(/img-src data:;/.test(srcdoc), 'images blocked by default');
  assertTrue(/img-src data: https: http:;/.test(buildEmailDocument('', { allowRemote: true }).srcdoc), 'opt-in');
  assertTrue(!buildEmailDocument('<p>plain</p>').hasRemote, 'plain has no remote');
  assertTrue(buildEmailDocument('<div style="background:url(https://t.example/x)">a</div>').hasRemote, 'css remote');
});

await test('do-not-disturb periods end at the right time', () => {
  const now = new Date(2026, 10, 2, 22, 15);
  assertEqual(dndEnd('30m', now), now.getTime() + 30 * 60000);
  assertEqual(dndEnd('4h', now), now.getTime() + 4 * 3600000, 'crosses midnight');
  assertEqual(dndEnd('today', now), new Date(2026, 10, 3).getTime(), 'local midnight');
  assertEqual(dndEnd('forever', now), null);
  assertTrue(isDndOn({ until: null }), 'indefinite');
  assertTrue(isDndOn({ until: now.getTime() + 1 }, now.getTime()), 'running');
  assertTrue(!isDndOn({ until: now.getTime() }, now.getTime()), 'expired');
  assertTrue(!isDndOn(undefined), 'unset');
  assertEqual(dndStatus({ choice: 'forever', until: null }), 'on');
  assertEqual(dndStatus({ choice: 'today', until: 1 }), 'on for the rest of today');
  assertTrue(/^on until \d/.test(dndStatus({ choice: '1h', until: now.getTime() })), 'shows end time');
});

await test('link schemes are limited', () => {
  assertTrue(isSafeExternalLink('https://example.com'));
  assertTrue(isSafeExternalLink('mailto:a@example.com'));
  assertTrue(!isSafeExternalLink('javascript:alert(1)'));
  assertTrue(!isSafeExternalLink('file:///etc/passwd'));
  assertTrue(!isSafeExternalLink('not a url'));
});

await test('the sandboxed frame really blocks scripts and remote images', async () => {
  window.frameScriptRan = false;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  // Bypasses the stripper on purpose, to test the frame alone.
  const { srcdoc } = buildEmailDocument('<p id="p">body</p>');
  frame.srcdoc = srcdoc.replace('</body>', '<script>parent.frameScriptRan = true;</' + 'script><img id="i" src="https://example.com/x.png"></body>');
  const loaded = new Promise((resolve) => { frame.onload = resolve; });
  document.getElementById('frames').append(frame);
  await loaded;
  assertEqual(frame.contentDocument.getElementById('p').textContent, 'body', 'content rendered');
  assertEqual(window.frameScriptRan, false, 'script execution');
  assertEqual(frame.contentDocument.getElementById('i').naturalWidth, 0, 'remote image');
  frame.remove();
});

// ---- End-to-end tests: the real background page, with only Zoho's servers mocked ----

const bg = await browser.runtime.getBackgroundPage();
const mock = createMock();
bg.fetch = mock.fetch;
window.mock = mock;
const ID1 = '1709876190693100011';
const ID2 = '1709876190693100012';
const ID3 = '1709876190693100013';
const ID4 = '1709876190693100014';
const ID5 = '1709876190693100015';
const badge = () => browser.action.getBadgeText({});
const lastCall = (fn) => [...mock.calls].reverse().find(fn);
const unreadIds = async () => (await send('getState')).inbox.byAccount[ACCOUNT_ID].messages.map((m) => m.id);
const ref = (id) => ({ id, folderId: INBOX_ID });

await test('a fresh install shows no badge and no connections', async () => {
  const state = await send('getState');
  assertEqual(state.connections, []);
  assertEqual(state.configured, false);
  assertEqual(await badge(), '');
});

await test('Zoho host permissions are declared for every region', async () => {
  const declared = browser.runtime.getManifest().host_permissions;
  for (const region of Object.values(REGIONS)) {
    assertTrue(declared.includes(`${region.accounts}/*`), region.accounts);
    assertTrue(declared.includes(`${region.mail}/*`), region.mail);
  }
  results.push(`INFO host permissions granted on install: ${await browser.permissions.contains({ origins: declared })}`);
});

await test('the redirect URL is stable and HTTPS', () => {
  const uri = browser.identity.getRedirectURL();
  assertTrue(/^https:\/\/[0-9a-f]+\.extensions\.allizom\.org\/$/.test(uri), uri);
  results.push(`INFO redirect URI: ${uri}`);
});

await test('connecting loads accounts, defaults to Inbox, and stays silent about backlog', async () => {
  await browser.storage.local.set({ settings: { clientId: 'id', clientSecret: 'secret', region: 'eu', sound: false } });
  mock.unread = [message(ID1, 'Ann &amp; Co', 'First', 'one', 30), message(ID2, 'Bob', 'Second', 'two', 10)];
  await send('addConnection', { tokens: { region: 'eu', refreshToken: 'refresh-1', accessToken: 'access-1', expiresAt: Date.now() + 3600000 } });
  const state = await send('getState');
  assertEqual(state.configured, true);
  const account = state.connections[0].accounts[0];
  assertEqual(account.accountId, ACCOUNT_ID, 'account ID precision');
  assertEqual(account.email, 'me@example.com');
  assertEqual(account.watchedFolderIds, [INBOX_ID], 'watched folders');
  assertEqual(await unreadIds(), [ID2, ID1], 'sorted newest first with exact IDs');
  assertEqual(await badge(), '2');
  assertEqual(Object.keys(await browser.notifications.getAll()), [], 'no backlog notifications');
  assertTrue(mock.calls.every((c) => c.origin.endsWith('zoho.eu')), 'uses the EU data centre');
});

await test('pages are never handed tokens', async () => {
  const text = JSON.stringify(await send('getState'));
  assertTrue(!/refresh-1|access-1|secret/.test(text), 'state leaked a credential');
});

await test('new mail raises the badge and a notification', async () => {
  mock.unread.push(message(ID3, 'Cara', 'Third', 'three', 1));
  await send('check');
  assertEqual(await badge(), '3');
  assertEqual(Object.keys(await browser.notifications.getAll()), [`message:${ID3}`]);
  const { notificationLinks } = await browser.storage.session.get('notificationLinks');
  assertEqual(notificationLinks[`message:${ID3}`], `https://mail.zoho.eu/zm/#mail/folder/inbox/p/${ID3}`);
  await send('check');
  assertEqual(Object.keys(await browser.notifications.getAll()), [`message:${ID3}`], 'no repeat');
});

await test('a burst of new mail is summarised', async () => {
  await browser.notifications.clear(`message:${ID3}`);
  const burst = ['1709876190693100021', '1709876190693100022', '1709876190693100023', '1709876190693100024'];
  mock.unread.push(...burst.map((id) => message(id, 'List', 'Burst', '', 1)));
  await send('check');
  const ids = Object.keys(await browser.notifications.getAll());
  assertEqual(ids.length, 1);
  assertTrue(ids[0].startsWith('summary:'), ids[0]);
  await browser.notifications.clear(ids[0]);
  await send('action', { action: 'markRead', accountId: ACCOUNT_ID, messages: burst.map(ref) });
  assertEqual(await badge(), '3');
});

await test('archive sends the documented body and updates the badge at once', async () => {
  await send('action', { action: 'archive', accountId: ACCOUNT_ID, messages: [ref(ID1)] });
  const call = lastCall((c) => c.pathname.endsWith('/updatemessage'));
  assertEqual(call.method, 'PUT');
  assertEqual(call.body, `{"mode":"archiveMails","messageId":[${ID1}]}`);
  assertEqual(await badge(), '2');
});

await test('a message acted on stays gone even if Zoho still lists it', async () => {
  mock.unread.push(message(ID1, 'Ann', 'First', 'one', 30));
  await send('check');
  assertEqual((await unreadIds()).includes(ID1), false);
  mock.unread = mock.unread.filter((m) => m.id !== ID1);
});

await test('spam and mark read use the right modes', async () => {
  await send('action', { action: 'spam', accountId: ACCOUNT_ID, messages: [ref(ID2)] });
  assertEqual(lastCall((c) => c.pathname.endsWith('/updatemessage')).body, `{"mode":"moveToSpam","messageId":[${ID2}]}`);
  await send('action', { action: 'markRead', accountId: ACCOUNT_ID, messages: [ref(ID3)] });
  assertEqual(lastCall((c) => c.pathname.endsWith('/updatemessage')).body, `{"mode":"markAsRead","messageId":[${ID3}]}`);
  assertEqual(await badge(), '');
});

await test('delete moves to Trash and never expunges', async () => {
  mock.unread.push(message(ID4, 'Dee', 'Fourth', 'four', 1));
  await send('check');
  await send('action', { action: 'delete', accountId: ACCOUNT_ID, messages: [ref(ID4)] });
  const call = lastCall((c) => c.method === 'DELETE');
  assertEqual(call.pathname, `/api/accounts/${ACCOUNT_ID}/folders/${INBOX_ID}/messages/${ID4}`);
  assertEqual(call.search, '', 'no expunge');
  await browser.notifications.clear(`message:${ID4}`);
});

await test('a failed action reports the error and restores the message', async () => {
  mock.unread.push(message(ID5, 'Eve', 'Fifth', 'five', 1));
  await send('check');
  const realFetch = bg.fetch;
  bg.fetch = async (url, options) => (options.method === 'PUT'
    ? new Response('{"status":{"code":500,"description":"Internal error"},"data":{}}', { status: 500 })
    : realFetch(url, options));
  await assertRejects(send('action', { action: 'archive', accountId: ACCOUNT_ID, messages: [ref(ID5)] }), /Internal error/);
  bg.fetch = realFetch;
  await send('check');
  assertEqual(await unreadIds(), [ID5], 'message is back');
});

await test('message content, Reply-To and replies', async () => {
  mock.content = '<p>Body</p>';
  assertEqual(await send('getContent', { accountId: ACCOUNT_ID, folderId: INBOX_ID, messageId: ID5 }), '<p>Body</p>');
  assertEqual(await send('getReplyTo', { accountId: ACCOUNT_ID, folderId: INBOX_ID, messageId: ID5 }), 'support@example.com');
  await send('sendReply', { accountId: ACCOUNT_ID, messageId: ID5, to: 'support@example.com', subject: 'Re: Fifth', content: 'Thanks "all"' });
  const call = lastCall((c) => c.method === 'POST' && c.pathname.includes('/messages/'));
  assertEqual(call.pathname, `/api/accounts/${ACCOUNT_ID}/messages/${ID5}`);
  assertEqual(JSON.parse(call.body), {
    fromAddress: 'me@example.com', toAddress: 'support@example.com', subject: 'Re: Fifth', content: 'Thanks "all"', mailFormat: 'plaintext', action: 'reply',
  });
});

await test('an expired access token is refreshed and the call retried', async () => {
  const before = mock.refreshCount;
  mock.validToken = 'rotated-on-server';
  // The mock issues access-N on refresh, so the retry succeeds with the new token.
  await send('check');
  assertEqual(mock.refreshCount, before + 1);
  assertEqual((await send('getState')).inbox.byAccount[ACCOUNT_ID].error, null);
  assertEqual(await badge(), '1');
});

await test('changing watched folders checks them without a notification flood', async () => {
  const { NEWS_ID } = await import('./mock-zoho.js');
  await browser.notifications.getAll().then((all) => Promise.all(Object.keys(all).map((id) => browser.notifications.clear(id))));
  const old = message('1709876190693100031', 'News', 'Old letter', '', 600);
  old.folderId = NEWS_ID;
  mock.unread.push(old);
  await send('setWatchedFolders', { accountId: ACCOUNT_ID, folderIds: [INBOX_ID, NEWS_ID] });
  assertEqual(await badge(), '2');
  assertEqual(Object.keys(await browser.notifications.getAll()), []);
  await send('setWatchedFolders', { accountId: ACCOUNT_ID, folderIds: [INBOX_ID] });
  assertEqual(await badge(), '1');
});

await test('a revoked sign-in is flagged but keeps the last good list', async () => {
  mock.validToken = 'rotated-again';
  mock.refreshError = 'invalid_code';
  await send('check');
  const state = await send('getState');
  assertEqual(state.connections[0].needsReauth, true);
  assertTrue(/Reconnect/.test(state.inbox.byAccount[ACCOUNT_ID].error), 'error shown');
  assertEqual(state.inbox.byAccount[ACCOUNT_ID].messages.length, 1, 'list retained');
  mock.refreshError = null;
});

await test('reconnecting the same login replaces it', async () => {
  mock.validToken = 'access-new';
  await send('addConnection', { tokens: { region: 'eu', refreshToken: 'refresh-2', accessToken: 'access-new', expiresAt: Date.now() + 3600000 } });
  const state = await send('getState');
  assertEqual(state.connections.length, 1);
  assertEqual(state.connections[0].needsReauth, false);
});

await test('do not disturb silences new mail until it is turned off', async () => {
  await browser.notifications.getAll().then((all) => Promise.all(Object.keys(all).map((id) => browser.notifications.clear(id))));
  // The menu items exist: updating a missing one rejects.
  await browser.menus.update('dnd-off', {});
  await send('setDoNotDisturb', { choice: '30m' });
  const { dnd } = await send('getState');
  assertTrue(/^on until/.test(dnd.status), dnd.status);
  assertEqual((await browser.alarms.get(DND_ALARM)).scheduledTime, dnd.until, 'end alarm');
  assertTrue((await browser.action.getTitle({})).includes('(do not disturb on until'), 'tooltip');

  mock.unread.push(message('1709876190693100051', 'Quiet', 'During DND', '', 1));
  await send('check');
  assertEqual(await badge(), '2', 'badge still counts');
  assertEqual(Object.keys(await browser.notifications.getAll()), [], 'no notification');

  await send('setDoNotDisturb', { choice: 'forever' });
  assertEqual((await send('getState')).dnd.status, 'on');
  assertEqual(await browser.alarms.get(DND_ALARM), undefined, 'no end alarm');

  await send('setDoNotDisturb', { choice: null });
  assertEqual((await send('getState')).dnd, null);
  assertTrue(!(await browser.action.getTitle({})).includes('disturb'), 'tooltip restored');
  mock.unread.push(message('1709876190693100052', 'Loud', 'After DND', '', 1));
  await send('check');
  assertEqual(Object.keys(await browser.notifications.getAll()), ['message:1709876190693100052'], 'only the new one');
});

await test('disconnecting revokes the token and clears the badge', async () => {
  const { connections } = await send('getState');
  await send('removeConnection', { connectionId: connections[0].id });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEqual(mock.revoked, ['refresh-2']);
  assertEqual((await send('getState')).connections, []);
  assertEqual(await badge(), '');
  const { connections: stored } = await browser.storage.local.get('connections');
  assertEqual(stored, [], 'token removed from storage');
});

const failed = results.filter((r) => r.startsWith('FAIL')).length;
const passed = results.filter((r) => r.startsWith('PASS')).length;
results.push(`DONE ${passed} passed, ${failed} failed`);
document.getElementById('output').textContent = results.join('\n');

// Leave a realistic mailbox behind for the screenshot stage of the driver.
mock.validToken = 'access-demo';
mock.unread = [
  message('1709876190693100041', 'Priya Natarajan', 'Q4 budget review: comments by Friday', 'Hi, I have added notes to the second tab. Could you take a look before Friday?', 12),
  message('1709876190693100042', 'Northwind Invoices', 'Invoice 20417 is ready', 'Your invoice for October is attached. Payment is due within 30 days.', 95),
  message('1709876190693100043', 'Sam Oduya', 'Lunch next week?', 'Are you around on Tuesday or Wednesday? There is a new place near the office.', 300),
];
mock.unread[1].attachment = true;
mock.content = '<h2 style="color:#1668dc">Q4 budget review</h2><p>Hi,</p><p>I have added notes to the second tab. Could you take a look before Friday?</p><p><img src="https://example.com/tracker.png" alt="[remote image]"></p><p><a href="https://example.com/budget">Open the budget</a></p><script>document.body.textContent = "SCRIPT RAN";</' + 'script>';
await browser.storage.local.set({ settings: { clientId: 'id', clientSecret: 'secret', region: 'eu', sound: false, notify: false } });
await send('addConnection', { tokens: { region: 'eu', refreshToken: 'refresh-demo', accessToken: 'access-demo', expiresAt: Date.now() + 3600000 } });
window.testsFinished = true;
document.title = 'finished';
