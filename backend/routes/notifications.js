/** Notification inbox. */
import { Router } from '../lib/http.js';
import { parsePagination } from '../lib/validate.js';
import { all, get, run } from '../db/index.js';
import { unreadCount } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';

const router = new Router();

router.get('/', async (ctx) => {
  const { page, pageSize, offset } = parsePagination(ctx.query, { defaultSize: 30 });
  const onlyUnread = ctx.query.unread === 'true';

  const where = onlyUnread ? 'user_id = ? AND read_at IS NULL' : 'user_id = ?';
  const rows = all(
    `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ctx.user.id, pageSize, offset
  );
  const total = get(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`, ctx.user.id)?.n ?? 0;

  return {
    notifications: rows.map((r) => ({
      id: r.public_id,
      type: r.type,
      severity: r.severity,
      title: r.title,
      body: r.body,
      link: r.link,
      read: r.read_at !== null,
      createdAt: r.created_at,
    })),
    unread: unreadCount(ctx.user.id),
    total, page, pageSize,
  };
});

router.get('/count', async (ctx) => ({ unread: unreadCount(ctx.user.id) }));

router.post('/:id/read', async (ctx) => {
  const row = get(
    `SELECT * FROM notifications WHERE public_id = ? AND user_id = ?`,
    ctx.params.id, ctx.user.id
  );
  if (!row) throw notFound('Notification not found.');
  run(`UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL`, row.id);
  return { ok: true, unread: unreadCount(ctx.user.id) };
});

router.post('/read-all', async (ctx) => {
  const result = run(
    `UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`,
    ctx.user.id
  );
  return { ok: true, marked: result.changes, unread: 0 };
});

router.delete('/:id', async (ctx) => {
  const row = get(
    `SELECT * FROM notifications WHERE public_id = ? AND user_id = ?`,
    ctx.params.id, ctx.user.id
  );
  if (!row) throw notFound('Notification not found.');
  run(`DELETE FROM notifications WHERE id = ?`, row.id);
  return { ok: true };
});

router.delete('/', async (ctx) => {
  const result = run(`DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL`, ctx.user.id);
  return { ok: true, deleted: result.changes };
});

export default router;
