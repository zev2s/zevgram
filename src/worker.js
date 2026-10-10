const encoder = new TextEncoder();
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});
const fail = (message, status = 400) => json({ error: message }, status);
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
const fromHex = value => new Uint8Array((value.match(/.{1,2}/g) || []).map(x => parseInt(x, 16)));

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(salt), iterations: 100000 }, key, 256));
}
async function tokenHash(token) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(token))); }
async function sessionUser(request, env) {
  const token = (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith('zevgram_session='))?.slice(16);
  if (!token) return null;
  try {
    return await env.DB.prepare(`SELECT u.login,u.username,u.name,u.bio,u.avatar,u.created_at
      FROM sessions s JOIN users u ON u.login=s.login WHERE s.token_hash=? AND s.expires_at>?`).bind(await tokenHash(token),Date.now()).first();
  } catch { return null; }
}
async function setSession(login, env) {
  const token=hex(crypto.getRandomValues(new Uint8Array(32))), expires=Date.now()+7*86400000;
  await env.DB.prepare('INSERT INTO sessions (token_hash,login,expires_at) VALUES (?,?,?)').bind(await tokenHash(token),login,expires).run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()).run();
  return `zevgram_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
}
function publicUser(row) {
  return row && { login: row.login, username: row.username || row.login, name: row.name, avatar: row.avatar || '', bio: row.bio || '', createdAt: row.created_at || row.createdAt };
}
async function body(request, limit = 12000) {
  const raw = await request.text();
  if (raw.length > limit) throw new Error('Слишком большой запрос.');
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('Не удалось прочитать данные запроса.'); }
}
async function postRows(env, login = '', onlyBookmarked = false) {
  let query = `SELECT p.id,p.text,p.created_at,u.login,u.username,u.name,u.avatar,
    (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) like_count,
    (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) comment_count,
    EXISTS(SELECT 1 FROM likes l WHERE l.post_id=p.id AND l.login=?) liked
    FROM posts p JOIN users u ON u.login=p.author_login`;
  if (onlyBookmarked) query += ' JOIN bookmarks b ON b.post_id=p.id AND b.login=?';
  const binds = onlyBookmarked ? [login, login] : [login];
  const rows = await env.DB.prepare(query + ' ORDER BY p.created_at DESC LIMIT 300').bind(...binds).all();
  return rows.results.map(r => ({ id:r.id, text:r.text, author:publicUser(r), createdAt:r.created_at, liked:!!r.liked, likeCount:r.like_count, commentCount:r.comment_count, saved:!!onlyBookmarked }));
}
async function handle(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method, db = env.DB;
  const me = await sessionUser(request, env);
  if (method === 'GET' && path === '/api/status') return json({ hasAccounts: !!(await db.prepare('SELECT 1 FROM users LIMIT 1').first()) });
  if (method === 'GET' && path === '/api/me') return json({ user: publicUser(me) });
  if (method === 'POST' && path === '/api/register') {
    const { name = '', login = '', password = '' } = await body(request), normalized = String(login).trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(normalized)) return fail('Логин: латинские буквы, цифры и _ (от 3 символов).');
    if (String(password).length < 6 || String(password).length > 200) return fail('Пароль должен содержать от 6 до 200 символов.');
    const salt = hex(crypto.getRandomValues(new Uint8Array(16))), hash = await passwordHash(String(password), salt), created = now();
    try {
      await db.prepare('INSERT INTO users (login,username,name,salt,password_hash,created_at) VALUES (?,?,?,?,?,?)').bind(normalized, normalized, String(name).trim().slice(0,30) || normalized, salt, hash, created).run();
    } catch { return fail('Такой логин уже занят. Выбери другой.', 409); }
    return json({ user: { login:normalized, username:normalized, name:String(name).trim().slice(0,30)||normalized, createdAt:created } }, 201, { 'Set-Cookie': await setSession(normalized, env) });
  }
  if (method === 'POST' && path === '/api/login') {
    const { login = '', password = '' } = await body(request), normalized = String(login).trim().toLowerCase();
    const row = await db.prepare('SELECT * FROM users WHERE login=?').bind(normalized).first();
    if (!row || await passwordHash(String(password), row.salt) !== row.password_hash) return fail('Неверный логин или пароль.', 401);
    return json({ user: publicUser(row) }, 200, { 'Set-Cookie': await setSession(normalized, env) });
  }
  if (method === 'POST' && path === '/api/logout') {
    const token=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('zevgram_session='))?.slice(16);
    if (token) await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await tokenHash(token)).run();
    return json({ ok:true }, 200, { 'Set-Cookie':'zevgram_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
  }
  if (method === 'GET' && path === '/api/users') {
    const result = await db.prepare(`SELECT u.login,u.username,u.name,u.avatar,u.bio,
      EXISTS(SELECT 1 FROM friends f WHERE f.login=? AND f.friend_login=u.login) isFriend
      FROM users u WHERE u.login != ? ORDER BY u.created_at DESC LIMIT 200`).bind(me?.login || '', me?.login || '').all();
    return json({ users:result.results.map(r => ({ ...publicUser(r), isFriend:!!r.isFriend })) });
  }
  if (method === 'GET' && path === '/api/friends') {
    if (!me) return fail('Сначала войди в профиль.', 401);
    const result = await db.prepare('SELECT u.login,u.username,u.name,u.avatar,u.bio,u.created_at FROM friends f JOIN users u ON u.login=f.friend_login WHERE f.login=? ORDER BY u.name').bind(me.login).all();
    return json({ friends:result.results.map(publicUser) });
  }
  if (method === 'POST' && path === '/api/friends') {
    if (!me) return fail('Сначала войди в профиль.', 401);
    const { login = '' } = await body(request), target = String(login).toLowerCase();
    if (!await db.prepare('SELECT 1 FROM users WHERE login=?').bind(target).first() || target === me.login) return fail('Профиль не найден.', 404);
    const existing = await db.prepare('SELECT 1 FROM friends WHERE login=? AND friend_login=?').bind(me.login,target).first();
    if (existing) await db.batch([db.prepare('DELETE FROM friends WHERE login=? AND friend_login=?').bind(me.login,target), db.prepare('DELETE FROM friends WHERE login=? AND friend_login=?').bind(target,me.login)]);
    else await db.batch([db.prepare('INSERT OR IGNORE INTO friends VALUES (?,?)').bind(me.login,target), db.prepare('INSERT OR IGNORE INTO friends VALUES (?,?)').bind(target,me.login)]);
    return json({ isFriend:!existing });
  }
  if (method === 'GET' && path === '/api/profile') {
    const login = String(url.searchParams.get('login') || '').toLowerCase(), profile = await db.prepare('SELECT login,username,name,avatar,bio,created_at FROM users WHERE login=?').bind(login).first();
    if (!profile) return fail('Профиль не найден.', 404);
    const [posts, counts] = await Promise.all([env.DB.prepare(`SELECT p.id,p.text,p.created_at,u.login,u.username,u.name,u.avatar,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) comment_count
      FROM posts p JOIN users u ON u.login=p.author_login WHERE p.author_login=? ORDER BY p.created_at DESC`).bind(login).all(),
      env.DB.prepare('SELECT (SELECT COUNT(*) FROM posts WHERE author_login=?) posts_count,(SELECT COUNT(*) FROM friends WHERE login=?) friends_count').bind(login,login).first()]);
    return json({ profile:{...publicUser(profile),postsCount:counts.posts_count,friendsCount:counts.friends_count}, posts:posts.results.map(r=>({id:r.id,text:r.text,author:publicUser(r),createdAt:r.created_at,liked:false,likeCount:r.like_count,commentCount:r.comment_count})) });
  }
  if (method === 'PATCH' && path === '/api/profile') {
    if (!me) return fail('Сначала войди в профиль.', 401);
    const { name='', username=me.username||me.login, bio='' } = await body(request), handle=String(username).trim().replace(/^@/,'').toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(handle)) return fail('Ник: латинские буквы, цифры и _ (от 3 до 24 символов).');
    try { await db.prepare('UPDATE users SET name=?,username=?,bio=? WHERE login=?').bind(String(name).trim().slice(0,30)||me.login,handle,String(bio).trim().slice(0,240),me.login).run(); }
    catch { return fail('Этот ник уже занят.', 409); }
    return json({ user:publicUser(await db.prepare('SELECT login,username,name,bio,avatar,created_at FROM users WHERE login=?').bind(me.login).first()) });
  }
  if (method === 'POST' && path === '/api/avatar') {
    if (!me) return fail('Сначала войди в профиль.', 401);
    const { image='' } = await body(request, 1800000);
    if (typeof image !== 'string' || !/^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/.test(image) || image.length > 1400000) return fail('Выбери изображение WebP размером до 1 МБ.');
    await db.prepare('UPDATE users SET avatar=? WHERE login=?').bind(image,me.login).run();
    return json({ user:publicUser(await db.prepare('SELECT login,username,name,bio,avatar,created_at FROM users WHERE login=?').bind(me.login).first()) });
  }
  if (method === 'GET' && path === '/api/posts') return json({ posts:await postRows(env, me?.login || '') });
  if (method === 'POST' && path === '/api/posts') {
    if (!me) return fail('Сначала войди в профиль.', 401);
    const { text='' } = await body(request), clean=String(text).trim().slice(0,1800);
    if (!clean) return fail('Напиши что-нибудь перед публикацией.');
    const post={id:id(),text:clean,author:publicUser(me),createdAt:now(),liked:false,likeCount:0,commentCount:0};
    await db.prepare('INSERT INTO posts (id,author_login,text,created_at) VALUES (?,?,?,?)').bind(post.id,me.login,post.text,post.createdAt).run();
    return json({post},201);
  }
  const likeMatch=path.match(/^\/api\/posts\/([a-f0-9-]+)\/like$/i);
  if (method==='POST' && likeMatch) {
    if (!me) return fail('Сначала войди в профиль.',401);
    const postId=likeMatch[1], exists=await db.prepare('SELECT 1 FROM likes WHERE post_id=? AND login=?').bind(postId,me.login).first();
    if (!await db.prepare('SELECT 1 FROM posts WHERE id=?').bind(postId).first()) return fail('Публикация не найдена.',404);
    if (exists) await db.prepare('DELETE FROM likes WHERE post_id=? AND login=?').bind(postId,me.login).run();
    else await db.prepare('INSERT INTO likes VALUES (?,?)').bind(postId,me.login).run();
    return json({liked:!exists,likeCount:(await db.prepare('SELECT COUNT(*) count FROM likes WHERE post_id=?').bind(postId).first()).count});
  }
  const commentMatch=path.match(/^\/api\/posts\/([a-f0-9-]+)\/comments$/i);
  if (commentMatch && method==='GET') {
    const comments=await db.prepare('SELECT c.id,c.text,c.created_at,u.login,u.username,u.name,u.avatar FROM comments c JOIN users u ON u.login=c.author_login WHERE c.post_id=? ORDER BY c.created_at').bind(commentMatch[1]).all();
    return json({comments:comments.results.map(r=>({id:r.id,text:r.text,createdAt:r.created_at,author:publicUser(r)}))});
  }
  if (commentMatch && method==='POST') {
    if (!me) return fail('Сначала войди в профиль.',401);
    const {text=''}=await body(request), clean=String(text).trim().slice(0,500);
    if (!clean) return fail('Комментарий пустой.');
    const postId=commentMatch[1]; if (!await db.prepare('SELECT 1 FROM posts WHERE id=?').bind(postId).first()) return fail('Публикация не найдена.',404);
    const comment={id:id(),text:clean,author:publicUser(me),createdAt:now()};
    await db.prepare('INSERT INTO comments VALUES (?,?,?,?,?)').bind(comment.id,postId,me.login,clean,comment.createdAt).run();
    return json({comment,commentCount:(await db.prepare('SELECT COUNT(*) count FROM comments WHERE post_id=?').bind(postId).first()).count},201);
  }
  if (method==='GET' && path==='/api/bookmarks') {
    if (!me) return fail('Сначала войди в профиль.',401);
    return json({posts:await postRows(env,me.login,true)});
  }
  if (method==='POST' && path==='/api/bookmarks') {
    if (!me) return fail('Сначала войди в профиль.',401);
    const {postId=''}=await body(request), exists=await db.prepare('SELECT 1 FROM bookmarks WHERE login=? AND post_id=?').bind(me.login,postId).first();
    if (!await db.prepare('SELECT 1 FROM posts WHERE id=?').bind(postId).first()) return fail('Публикация не найдена.',404);
    if (exists) await db.prepare('DELETE FROM bookmarks WHERE login=? AND post_id=?').bind(me.login,postId).run();
    else await db.prepare('INSERT INTO bookmarks VALUES (?,?)').bind(me.login,postId).run();
    return json({saved:!exists});
  }
  if (method==='GET' && path==='/api/messages') {
    if (!me) return fail('Сначала войди в профиль.',401);
    const other=String(url.searchParams.get('with')||'').toLowerCase(), rows=await db.prepare(`SELECT m.id,m.text,m.created_at,u.login,u.username,u.name,u.avatar FROM messages m JOIN users u ON u.login=m.from_login WHERE (m.from_login=? AND m.to_login=?) OR (m.from_login=? AND m.to_login=?) ORDER BY m.created_at LIMIT 500`).bind(me.login,other,other,me.login).all();
    return json({messages:rows.results.map(r=>({id:r.id,text:r.text,createdAt:r.created_at,from:r.login,author:publicUser(r)}))});
  }
  if (method==='POST' && path==='/api/messages') {
    if (!me) return fail('Сначала войди в профиль.',401);
    const {to='',text=''}=await body(request), recipient=String(to).trim().toLowerCase(), clean=String(text).trim().slice(0,2000);
    if (!await db.prepare('SELECT 1 FROM users WHERE login=?').bind(recipient).first()||recipient===me.login) return fail('Пользователь не найден.',404);
    if (!clean) return fail('Сообщение пустое.');
    const message={id:id(),from:me.login,to:recipient,text:clean,createdAt:now()};
    await db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').bind(message.id,message.from,message.to,message.text,message.createdAt).run();
    return json({message:{...message,author:publicUser(me)}},201);
  }
  if (method==='GET' && path==='/api/groups') {
    const rows=await db.prepare(`SELECT g.id,g.name,g.description,g.creator,g.created_at,
      (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) member_count,
      EXISTS(SELECT 1 FROM group_members m WHERE m.group_id=g.id AND m.login=?) is_member
      FROM groups_ g ORDER BY g.created_at DESC LIMIT 200`).bind(me?.login||'').all();
    return json({groups:rows.results.map(r=>({id:r.id,name:r.name,description:r.description,creator:r.creator,members:[],createdAt:r.created_at,memberCount:r.member_count,isMember:!!r.is_member}))});
  }
  if (method==='POST' && path==='/api/groups') {
    if (!me) return fail('Сначала войди в профиль.',401);
    const {name='',description=''}=await body(request), clean=String(name).trim().slice(0,50);
    if (clean.length<2) return fail('Название должно быть длиннее одного символа.');
    const group={id:id(),name:clean,description:String(description).trim().slice(0,300),creator:me.login,members:[me.login],createdAt:now()};
    await db.batch([db.prepare('INSERT INTO groups_ VALUES (?,?,?,?,?)').bind(group.id,group.name,group.description,group.creator,group.createdAt),db.prepare('INSERT INTO group_members VALUES (?,?)').bind(group.id,me.login)]);
    return json({group:{...group,isMember:true,memberCount:1}},201);
  }
  const joinMatch=path.match(/^\/api\/groups\/([a-f0-9-]+)\/join$/i);
  if (method==='POST' && joinMatch) {
    if (!me) return fail('Сначала войди в профиль.',401);
    const groupId=joinMatch[1]; if (!await db.prepare('SELECT 1 FROM groups_ WHERE id=?').bind(groupId).first()) return fail('Сообщество не найдено.',404);
    const exists=await db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND login=?').bind(groupId,me.login).first();
    if (exists) await db.prepare('DELETE FROM group_members WHERE group_id=? AND login=?').bind(groupId,me.login).run();
    else await db.prepare('INSERT INTO group_members VALUES (?,?)').bind(groupId,me.login).run();
    return json({isMember:!exists,memberCount:(await db.prepare('SELECT COUNT(*) count FROM group_members WHERE group_id=?').bind(groupId).first()).count});
  }
  return fail('Страница не найдена.',404);
}

export default {
  async fetch(request, env) {
    try {
      if (!request.url.includes('/api/') && env.ASSETS) return env.ASSETS.fetch(request);
      return await handle(request, env);
    } catch (error) {
      return json({error:error instanceof Error ? error.message : 'Внутренняя ошибка сервера.'},500);
    }
  }
};

