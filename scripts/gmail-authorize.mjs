// 危機メール（Gmail API）の一度きりの認可：ローカルで OAuth のループバック フローを完了し、Terraform 変数用の JSON を出力する。
// 前提：このプロジェクトの GCP コンソールで「デスクトップ アプリ」種別の OAuth クライアントを作り、送信に使う Google アカウントを
// 同意画面のテストユーザーに加えておく。使い方：
//   node scripts/gmail-authorize.mjs <clientId> <clientSecret> <senderEmail>
// ブラウザで senderEmail としてログインし gmail.send を許可すると、ターミナルに次の 1 行が出る：
//   export TF_VAR_gmail_sender_credentials='{"clientId":...,"clientSecret":...,"refreshToken":...,"sender":...}'
// この行をシェルに貼ってから terraform apply する。出力をファイルに書いたりコミットしたりしない。
import { createServer } from 'node:http';
import { exec } from 'node:child_process';

const [clientId, clientSecret, sender] = process.argv.slice(2);
if (!clientId || !clientSecret || !sender) {
  console.error('usage: node scripts/gmail-authorize.mjs <clientId> <clientSecret> <senderEmail>');
  process.exit(1);
}
const PORT = 8976;
const redirectUri = `http://127.0.0.1:${PORT}/callback`;
const scope = 'https://www.googleapis.com/auth/gmail.send';

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', redirectUri);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const value = url.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      error ? `認可に失敗しました: ${error}` : '認可が完了しました。このタブは閉じて構いません。',
    );
    server.close();
    if (error || !value) reject(new Error(error ?? 'no code'));
    else resolve(value);
  });
  server.listen(PORT, '127.0.0.1', () => {
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.searchParams.set('client_id', clientId);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', scope);
    auth.searchParams.set('access_type', 'offline');
    auth.searchParams.set('prompt', 'consent');
    auth.searchParams.set('login_hint', sender);
    console.error(`ブラウザで ${sender} として許可してください:\n${auth}`);
    exec(`open "${auth}"`);
  });
});

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }),
});
const token = await tokenRes.json();
if (!token.refresh_token) {
  console.error('refresh_token が返りませんでした:', JSON.stringify(token));
  process.exit(1);
}
const json = JSON.stringify({ clientId, clientSecret, refreshToken: token.refresh_token, sender });
console.log(`export TF_VAR_gmail_sender_credentials='${json}'`);
