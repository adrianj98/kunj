// Small HTTP helpers shared by the unary routes and the streams.

import * as http from 'http';
import { MAX_JSON_BODY, ServeError } from './protocol';

/** The JSON body, limited; an empty body is {}. */
export function readJsonBody(req: http.IncomingMessage, limit = MAX_JSON_BODY): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > limit) {
        // Not destroyed: the 413 must still reach the client. Node closes the connection after
        // the response and drops the rest of the body.
        chunks.length = 0;
        reject(new ServeError(413, 'too-large', `request body over ${limit} bytes`));
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ServeError(400, 'bad-request', 'body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Picks the authorization header's bearer token, if any. */
export function bearerOf(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : undefined;
}

