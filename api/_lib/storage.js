/* R2-shaped adapter over Cloudflare R2's S3-compatible API, signed with
   aws4fetch (edge-runtime safe: fetch + WebCrypto only, no Node APIs).

   The bucket itself does not move — this just reaches the same R2 bucket the
   Worker used to talk to over a binding, using an S3 access key instead.
   Bytes still only ever flow through this server: backend/routes/documents.js
   calls .get() and streams `body` back through its own Response, exactly as
   it did with the R2 binding, so a client never receives a direct/public URL
   to the bucket. Mirrors the three R2 methods backend/ actually calls:
     bucket.put(key, streamOrBytes, { httpMetadata, customMetadata })
     bucket.get(key) -> { body } | null
     bucket.delete(key) */
import { AwsClient } from 'aws4fetch';

let _client;
function client() {
  if (!_client) {
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) throw new Error('R2 credentials are not set.');
    _client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  }
  return _client;
}

function objectUrl(key) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  if (!accountId || !bucket) throw new Error('R2_ACCOUNT_ID / R2_BUCKET_NAME are not set.');
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${encodedKey}`;
}

export const DOCUMENTS = {
  async put(key, streamOrBytes, { httpMetadata, customMetadata } = {}) {
    // aws4fetch signs the request body, so a stream is buffered first — the
    // caller (documents.js) already caps uploads at 25 MB.
    const body = streamOrBytes instanceof Uint8Array
      ? streamOrBytes
      : new Uint8Array(await new Response(streamOrBytes).arrayBuffer());

    const headers = {};
    if (httpMetadata?.contentType) headers['content-type'] = httpMetadata.contentType;
    if (customMetadata) {
      for (const [k, v] of Object.entries(customMetadata)) headers[`x-amz-meta-${k}`] = String(v);
    }

    const res = await client().fetch(objectUrl(key), { method: 'PUT', body, headers });
    if (!res.ok) throw new Error(`R2 put failed: ${res.status} ${await res.text().catch(() => '')}`);
    return { key };
  },

  async get(key) {
    const res = await client().fetch(objectUrl(key), { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 get failed: ${res.status}`);
    return { body: res.body };
  },

  async delete(key) {
    const res = await client().fetch(objectUrl(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed: ${res.status}`);
  },
};
