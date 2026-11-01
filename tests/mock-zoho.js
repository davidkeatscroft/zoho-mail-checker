// A stand-in for Zoho's servers, installed over fetch in the real background page.
// Responses are raw text with 64-bit IDs as bare numbers, as a JS-unsafe API would send them.
export const ACCOUNT_ID = '2560636000000008002';
export const INBOX_ID = '1709876190693100001';
export const NEWS_ID = '1709876190693100002';

export function message(id, sender, subject, summary, ageMinutes = 5) {
  return { id, sender, subject, summary, receivedTime: Date.now() - ageMinutes * 60000, folderId: INBOX_ID };
}

const json = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
const ok = (dataText) => json(200, `{"status":{"code":200,"description":"success"},"data":${dataText}}`);

export function createMock() {
  const mock = {
    unread: [],
    calls: [],
    validToken: 'access-1',
    refreshError: null,
    refreshCount: 0,
    revoked: [],
    content: '<p>Hello</p>',
    headers: 'From: a@example.com\r\nReply-To: Support Team\r\n <support@example.com>\r\nSubject: x',
  };

  mock.fetch = async (url, options = {}) => {
    const { origin, pathname, searchParams } = new URL(url);
    const method = options.method || 'GET';
    const body = options.body == null ? null : String(options.body);
    mock.calls.push({ origin, pathname, search: searchParams.toString(), method, body, auth: options.headers?.Authorization });

    if (origin.includes('accounts.')) {
      if (pathname.endsWith('/revoke')) {
        mock.revoked.push(searchParams.get('token'));
        return json(200, '{"status":"success"}');
      }
      if (mock.refreshError) return json(200, JSON.stringify({ error: mock.refreshError }));
      mock.refreshCount += 1;
      mock.validToken = `access-${mock.refreshCount + 1}`;
      return json(200, JSON.stringify({ access_token: mock.validToken, expires_in: 3600 }));
    }

    if (options.headers?.Authorization !== `Zoho-oauthtoken ${mock.validToken}`) {
      return json(401, '{"status":{"code":401,"description":"Invalid Input"},"data":{"errorCode":"INVALID_OAUTHTOKEN"}}');
    }
    if (pathname === '/api/accounts') {
      return ok(`[{"accountId":${ACCOUNT_ID},"primaryEmailAddress":"me@example.com","displayName":"Me"}]`);
    }
    if (pathname.endsWith('/folders')) {
      return ok(`[{"folderId":${INBOX_ID},"folderName":"Inbox","path":"/Inbox","folderType":"Inbox"},`
        + `{"folderId":${NEWS_ID},"folderName":"Newsletters","path":"/Newsletters","folderType":"Normal"},`
        + `{"folderId":"999","folderName":"Spam","path":"/Spam","folderType":"Spam"}]`);
    }
    if (pathname.endsWith('/messages/view')) {
      const folder = searchParams.get('folderId');
      const start = Number(searchParams.get('start')) - 1;
      const limit = Number(searchParams.get('limit'));
      const rows = mock.unread.filter((m) => m.folderId === folder).slice(start, start + limit).map((m) => (
        `{"messageId":${m.id},"folderId":${m.folderId},"subject":${JSON.stringify(m.subject)},`
        + `"sender":${JSON.stringify(m.sender)},"fromAddress":"sender@example.com","summary":${JSON.stringify(m.summary)},`
        + `"receivedTime":"${m.receivedTime}","hasAttachment":"${m.attachment ? 1 : 0}"}`));
      return ok(`[${rows.join(',')}]`);
    }
    if (pathname.endsWith('/content')) {
      return ok(JSON.stringify({ messageId: '1', content: mock.content }));
    }
    if (pathname.endsWith('/header')) {
      return ok(JSON.stringify({ headerContent: mock.headers }));
    }
    if (pathname.endsWith('/updatemessage')) {
      const ids = JSON.parse(body.replace(/(\d{16,})/g, '"$1"')).messageId;
      if (!mock.keepAfterAction) mock.unread = mock.unread.filter((m) => !ids.includes(m.id));
      return ok('{}');
    }
    if (method === 'DELETE') {
      const id = pathname.split('/').pop();
      mock.unread = mock.unread.filter((m) => m.id !== id);
      return ok('{}');
    }
    if (method === 'POST' && /\/messages\/\d+$/.test(pathname)) {
      return ok('{"messageId":"1"}');
    }
    return json(404, '{"status":{"code":404,"description":"Not found"},"data":{}}');
  };
  return mock;
}
