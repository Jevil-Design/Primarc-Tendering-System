import { Router, handle, preflight } from './router.js';
import { json, fail, errors } from './lib/response.js';
import { resolveSession } from './auth.js';
import { loadPermissions } from './permissions.js';

import registerAuth from './routes/auth-routes.js';
import registerUsers from './routes/users.js';
import registerOrg from './routes/org.js';
import registerProjects from './routes/projects.js';
import registerVendors from './routes/vendors.js';
import registerMaterials from './routes/materials.js';
import registerBoqMaster from './routes/boq-master.js';
import registerBoq from './routes/boq.js';
import registerRateAnalysis from './routes/rate-analysis.js';
import registerEnquiries from './routes/enquiries.js';
import registerQuotations from './routes/quotations.js';
import registerComparison from './routes/comparison.js';
import registerWorkOrders from './routes/work-orders.js';
import registerPurchaseOrders from './routes/purchase-orders.js';
import registerNotifications from './routes/notifications.js';
import registerDocuments from './routes/documents.js';
import registerMigration from './routes/migration.js';

/* Routes that must work without a session. Everything else requires one —
   the default is "authenticated", so forgetting to guard a new route fails
   closed rather than open. */
const PUBLIC = new Set([
  'GET /',
  'POST /auth/login',
  'POST /auth/logout',
  'GET /auth/me',
  'POST /auth/bootstrap',
  'GET /health',
  'POST /vendor-portal/load',
  'POST /vendor-portal/save',
  'POST /vendor-portal/submit',
]);

const router = new Router();
router.get('/', (ctx) => ({
  ok: true,
  service: 'Primarc Tendering API',
  environment: ctx.env?.ENVIRONMENT || 'development',
  status: 'running',
  docs: '/health',
  ts: new Date().toISOString(),
}));
router.get('/health', () => ({ ok: true, ts: new Date().toISOString() }));

registerAuth(router);
registerUsers(router);
registerOrg(router);
registerProjects(router);
registerVendors(router);
registerMaterials(router);
registerBoqMaster(router);
registerBoq(router);
registerRateAnalysis(router);
registerEnquiries(router);
registerQuotations(router);
registerComparison(router);
registerWorkOrders(router);
registerPurchaseOrders(router);
registerNotifications(router);
registerDocuments(router);
registerMigration(router);

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return preflight(request, env);

    const url = new URL(request.url);
    const path = (url.pathname.replace(/^\/api/, '') || '/').replace(/\/$/, '') || '/';
    const key = `${request.method} ${path}`;

    let user = null, sessionId = null, permissions = {};
    try {
      const s = await resolveSession(env, request);
      if (s) {
        user = s.user;
        sessionId = s.sessionId;
        permissions = await loadPermissions(env, user);
      }
    } catch (err) {
      console.error('[session]', err);
    }

    // Fail closed: anything not explicitly public needs a live session.
    if (!user && !PUBLIC.has(key)) {
      return fail('UNAUTHORIZED', 'Your session has expired. Please sign in again.',
                  { status: 401, request, env });
    }

    return handle(router, request, env, { user, sessionId, permissions });
  },
};
