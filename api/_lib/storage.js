/* R2-shaped adapter over Vercel Blob (private store), edge-runtime safe —
   @vercel/blob authenticates via OIDC (VERCEL_OIDC_TOKEN + BLOB_STORE_ID),
   both populated automatically once a Blob store is connected to this
   project, so no manual API token/secret is needed.

   Private access means every read requires authentication and is only ever
   served through this server (get() then a Response built from its stream)
   — bytes never reach the client via a direct/public blob URL, matching the
   same design the R2 binding had. Mirrors the three methods backend/ calls:
     bucket.put(key, streamOrBytes, { httpMetadata, customMetadata })
     bucket.get(key) -> { body } | null
     bucket.delete(key) */
import { put, get, del } from '@vercel/blob';

export const DOCUMENTS = {
  async put(key, streamOrBytes, { httpMetadata } = {}) {
    await put(key, streamOrBytes, {
      access: 'private',
      contentType: httpMetadata?.contentType,
    });
    return { key };
  },

  async get(key) {
    const result = await get(key, { access: 'private' });
    if (!result || result.statusCode !== 200) return null;
    return { body: result.stream };
  },

  async delete(key) {
    await del(key);
  },
};
