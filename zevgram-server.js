// Local-only Zevgram demo server. Uses only Node.js built-in modules.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HOST = '127.0.0.1';
const PORT = 4173;
const ROOT = __dirname;
const DB = path.join(ROOT, 'zevgram-users.json');
const POSTS_DB = path.join(ROOT, 'zevgram-posts.json');
const SOCIAL_DB = path.join(ROOT, 'zevgram-social.json');
const sessions = new Map();

function readUsers() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
function saveUsers(users) {
  const temp = DB + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DB);
}
function readPosts() {
  try { return JSON.parse(fs.readFileSync(POSTS_DB, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function savePosts(posts) {
  const temp = POSTS_DB + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(posts, null, 2), { mode: 0o600 });
  fs.renameSync(temp, POSTS_DB);
}
function readSocial() {
  try { const data = JSON.parse(fs.readFileSync(SOCIAL_DB, 'utf8')); data.friends ||= {}; data.messages ||= []; data.groups ||= []; data.bookmarks ||= {}; return data; }
  catch (e) { if (e.code === 'ENOENT') return { friends: {}, messages: [], groups: [], bookmarks: {} }; throw e; }
}
function saveSocial(data) {
  const temp = SOCIAL_DB + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, SOCIAL_DB);
}
function json(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}
function readBody(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > maxBytes) { reject(new Error('Too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('='); return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
  }));
}
function publicUser(user) { return { login: user.login, username: user.username || user.login, name: user.name, avatar: user.avatar || '', bio: user.bio || '', createdAt: user.createdAt }; }
function current(req) { const session = sessions.get(cookies(req).zevgram_session); return session ? readUsers()[session.login] : null; }
function makeSession(res, login) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { login, createdAt: Date.now() });
  res.setHeader('Set-Cookie', `zevgram_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = current(req); return json(res, 200, { user: user ? publicUser(user) : null });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, { hasAccounts: Object.keys(readUsers()).length > 0 });
    }
    if (req.method === 'GET' && url.pathname === '/api/users') {
      const user = current(req), users = readUsers(), social = readSocial();
      return json(res, 200, { users: Object.values(users).filter(item => !user || item.login !== user.login).map(item => ({ ...publicUser(item), isFriend: !!user && (social.friends[user.login] || []).includes(item.login) })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/friends') {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const social = readSocial(), users = readUsers(); return json(res, 200, { friends: (social.friends[user.login] || []).map(login => users[login]).filter(Boolean).map(publicUser) });
    }
    if (req.method === 'POST' && url.pathname === '/api/friends') {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const { login = '' } = await readBody(req), target = String(login).toLowerCase(), users = readUsers();
      if (!users[target] || target === user.login) return json(res, 404, { error: 'Профиль не найден.' });
      const social = readSocial(); social.friends[user.login] ||= []; social.friends[target] ||= [];
      const exists = social.friends[user.login].includes(target);
      for (const [a, b] of [[user.login, target], [target, user.login]]) { social.friends[a] ||= []; const i = social.friends[a].indexOf(b); if (exists && i >= 0) social.friends[a].splice(i, 1); else if (!exists && i < 0) social.friends[a].push(b); }
      saveSocial(social); return json(res, 200, { isFriend: !exists });
    }
    if (req.method === 'GET' && url.pathname === '/api/bookmarks') {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const ids = readSocial().bookmarks[user.login] || [], posts = readPosts().filter(p => ids.includes(p.id));
      return json(res, 200, { posts: posts.map(p => ({ ...p, liked: p.likes.includes(user.login), likeCount: p.likes.length, commentCount: p.comments.length })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/bookmarks') {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const { postId = '' } = await readBody(req); if (!readPosts().some(p => p.id === postId)) return json(res, 404, { error: 'Публикация не найдена.' });
      const social = readSocial(); social.bookmarks[user.login] ||= []; const i = social.bookmarks[user.login].indexOf(postId);
      if (i >= 0) social.bookmarks[user.login].splice(i, 1); else social.bookmarks[user.login].push(postId);
      saveSocial(social); return json(res, 200, { saved: i < 0 });
    }
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const other = String(url.searchParams.get('with') || '').toLowerCase();
      const social = readSocial(), users = readUsers();
      const messages = social.messages.filter(m => (m.from === user.login && m.to === other) || (m.from === other && m.to === user.login)).map(m => ({ ...m, author: publicUser(users[m.from]) }));
      return json(res, 200, { messages });
    }
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const { to = '', text = '' } = await readBody(req), recipient = String(to).trim().toLowerCase(), cleanText = String(text).trim().slice(0, 2000), users = readUsers();
      if (!users[recipient] || recipient === user.login) return json(res, 404, { error: 'Пользователь не найден.' });
      if (!cleanText) return json(res, 400, { error: 'Сообщение пустое.' });
      const social = readSocial(), message = { id: crypto.randomUUID(), from: user.login, to: recipient, text: cleanText, createdAt: new Date().toISOString() };
      social.messages.push(message); saveSocial(social); return json(res, 201, { message: { ...message, author: publicUser(user) } });
    }
    if (req.method === 'GET' && url.pathname === '/api/groups') {
      const user = current(req), social = readSocial(); return json(res, 200, { groups: social.groups.map(g => ({ ...g, isMember: !!user && g.members.includes(user.login), memberCount: g.members.length })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/groups') {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const { name = '', description = '' } = await readBody(req), cleanName = String(name).trim().slice(0, 50);
      if (cleanName.length < 2) return json(res, 400, { error: 'Название должно быть длиннее одного символа.' });
      const social = readSocial(), group = { id: crypto.randomUUID(), name: cleanName, description: String(description).trim().slice(0, 300), creator: user.login, members: [user.login], createdAt: new Date().toISOString() };
      social.groups.unshift(group); saveSocial(social); return json(res, 201, { group: { ...group, isMember: true, memberCount: 1 } });
    }
    const joinMatch = url.pathname.match(/^\/api\/groups\/([a-f0-9-]+)\/join$/i);
    if (req.method === 'POST' && joinMatch) {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const social = readSocial(), group = social.groups.find(g => g.id === joinMatch[1]); if (!group) return json(res, 404, { error: 'Сообщество не найдено.' });
      const i = group.members.indexOf(user.login); if (i >= 0) group.members.splice(i, 1); else group.members.push(user.login); saveSocial(social);
      return json(res, 200, { isMember: i < 0, memberCount: group.members.length });
    }
    if (req.method === 'GET' && url.pathname === '/api/profile') {
      const login = String(url.searchParams.get('login') || '').toLowerCase(), users = readUsers(), profile = users[login];
      if (!profile) return json(res, 404, { error: 'Профиль не найден.' });
      const posts = readPosts().filter(p => p.author.login === login).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { profile: { ...publicUser(profile), bio: profile.bio || '', postsCount: posts.length, friendsCount: (readSocial().friends[login] || []).length }, posts: posts.map(p => ({ ...p, liked: false, likeCount: p.likes.length, commentCount: p.comments.length })) });
    }
    if (req.method === 'PATCH' && url.pathname === '/api/profile') {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const { name = '', username = user.username || user.login, bio = '' } = await readBody(req), users = readUsers();
      const handle = String(username).trim().replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9_]{3,24}$/.test(handle)) return json(res, 400, { error: 'Ник: латинские буквы, цифры и _ (от 3 до 24 символов).' });
      if (Object.values(users).some(item => item.login !== user.login && (item.username || item.login) === handle)) return json(res, 409, { error: 'Этот ник уже занят.' });
      users[user.login].name = String(name).trim().slice(0, 30) || user.login; users[user.login].username = handle; users[user.login].bio = String(bio).trim().slice(0, 240); saveUsers(users);
      return json(res, 200, { user: publicUser(users[user.login]) });
    }
    if (req.method === 'POST' && url.pathname === '/api/avatar') {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const { image = '' } = await readBody(req, 4 * 1024 * 1024);
      if (typeof image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(image) || Buffer.byteLength(image, 'utf8') > 3 * 1024 * 1024) return json(res, 400, { error: 'Выбери изображение PNG, JPG или WebP размером до 2 МБ.' });
      const users = readUsers(); users[user.login].avatar = image; saveUsers(users);
      return json(res, 200, { user: publicUser(users[user.login]) });
    }
    if (req.method === 'GET' && url.pathname === '/api/posts') {
      const user = current(req), posts = readPosts().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { posts: posts.map(post => ({ ...post, liked: !!user && post.likes.includes(user.login), likeCount: post.likes.length, commentCount: post.comments.length })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/posts') {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const { text = '' } = await readBody(req), cleanText = String(text).trim().slice(0, 1800);
      if (!cleanText) return json(res, 400, { error: 'Напиши что-нибудь перед публикацией.' });
      const posts = readPosts(), post = { id: crypto.randomUUID(), text: cleanText, author: publicUser(user), createdAt: new Date().toISOString(), likes: [], comments: [] };
      posts.push(post); savePosts(posts); return json(res, 201, { post: { ...post, liked: false, likeCount: 0, commentCount: 0 } });
    }
    const likeMatch = url.pathname.match(/^\/api\/posts\/([a-f0-9-]+)\/like$/i);
    if (req.method === 'POST' && likeMatch) {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const posts = readPosts(), post = posts.find(item => item.id === likeMatch[1]); if (!post) return json(res, 404, { error: 'Публикация не найдена.' });
      const i = post.likes.indexOf(user.login); if (i >= 0) post.likes.splice(i, 1); else post.likes.push(user.login); savePosts(posts);
      return json(res, 200, { liked: i < 0, likeCount: post.likes.length });
    }
    const commentsMatch = url.pathname.match(/^\/api\/posts\/([a-f0-9-]+)\/comments$/i);
    if (commentsMatch && req.method === 'GET') {
      const post = readPosts().find(item => item.id === commentsMatch[1]); if (!post) return json(res, 404, { error: 'Публикация не найдена.' });
      return json(res, 200, { comments: post.comments });
    }
    if (commentsMatch && req.method === 'POST') {
      const user = current(req); if (!user) return json(res, 401, { error: 'Сначала войди в профиль.' });
      const { text = '' } = await readBody(req), cleanText = String(text).trim().slice(0, 500); if (!cleanText) return json(res, 400, { error: 'Комментарий пустой.' });
      const posts = readPosts(), post = posts.find(item => item.id === commentsMatch[1]); if (!post) return json(res, 404, { error: 'Публикация не найдена.' });
      const comment = { id: crypto.randomUUID(), text: cleanText, author: publicUser(user), createdAt: new Date().toISOString() }; post.comments.push(comment); savePosts(posts);
      return json(res, 201, { comment, commentCount: post.comments.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/register') {
      const { name = '', login = '', password = '' } = await readBody(req);
      const normalized = String(login).trim().toLowerCase();
      if (!/^[a-z0-9_]{3,24}$/.test(normalized)) return json(res, 400, { error: 'Логин: латинские буквы, цифры и _ (от 3 символов).' });
      if (String(password).length < 6 || String(password).length > 200) return json(res, 400, { error: 'Пароль должен содержать от 6 до 200 символов.' });
      const users = readUsers();
      if (users[normalized]) return json(res, 409, { error: 'Такой логин уже занят. Выбери другой.' });
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
      users[normalized] = { login: normalized, name: String(name).trim().slice(0, 30) || normalized, salt, hash, createdAt: new Date().toISOString() };
      saveUsers(users); makeSession(res, normalized);
      return json(res, 201, { user: publicUser(users[normalized]) });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const { login = '', password = '' } = await readBody(req);
      const normalized = String(login).trim().toLowerCase(), user = readUsers()[normalized];
      if (!user) return json(res, 401, { error: 'Неверный логин или пароль.' });
      const candidate = crypto.scryptSync(String(password), user.salt, 64);
      if (!crypto.timingSafeEqual(candidate, Buffer.from(user.hash, 'hex'))) return json(res, 401, { error: 'Неверный логин или пароль.' });
      makeSession(res, normalized); return json(res, 200, { user: publicUser(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const token = cookies(req).zevgram_session; if (token) sessions.delete(token);
      res.setHeader('Set-Cookie', 'zevgram_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/zevgram.html')) {
      const page = fs.readFileSync(path.join(ROOT, 'zevgram.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(page);
    }
    return json(res, 404, { error: 'Страница не найдена' });
  } catch (err) {
    console.error(err); return json(res, 500, { error: 'Не удалось обработать запрос. Проверь файлы приложения.' });
  }
});
server.on('error', err => { console.error(err.message); process.exitCode = 1; });
server.listen(PORT, HOST, () => {
  console.log(`Zevgram открыт: http://${HOST}:${PORT}`);
  const { exec } = require('node:child_process');
  const command = process.platform === 'win32' ? `start "Zevgram" "http://${HOST}:${PORT}"` : `xdg-open "http://${HOST}:${PORT}"`;
  exec(command, { windowsHide: true });
});

