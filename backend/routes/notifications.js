import { newId } from '../lib/util.js';

export default function register(router) {
  router.get('/notifications', async (ctx) => {
    const limit = Math.min(parseInt(ctx.query.limit || '50', 10), 200);
    const rows = await ctx.env.DB.prepare(
      'select * from notifications where user_id = ? order by created_at desc limit ?'
    ).bind(ctx.user.id, limit).all();
    const unread = await ctx.env.DB.prepare(
      'select count(*) as n from notifications where user_id = ? and is_read = 0').bind(ctx.user.id).first();
    return { notifications: rows.results.map((r) => ({ ...r, is_read: !!r.is_read })), unread: unread.n };
  });

  // Scoped to the caller's own rows — a crafted id cannot mark someone else's read.
  router.post('/notifications/:id/read', async (ctx) => {
    await ctx.env.DB.prepare('update notifications set is_read = 1 where id = ? and user_id = ?')
      .bind(ctx.params.id, ctx.user.id).run();
    return { ok: true };
  });

  router.post('/notifications/read-all', async (ctx) => {
    await ctx.env.DB.prepare('update notifications set is_read = 1 where user_id = ? and is_read = 0')
      .bind(ctx.user.id).run();
    return { ok: true };
  });
}
