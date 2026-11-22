// The signed-in transport: Electron's net.request on the app's isolated pathofexile.com session. Cookies
// come from that session's store and are never read here; only the rate-limit, Retry-After and
// cf-mitigated headers are kept (pickHeaders). Electron's default user agent is kept (Hard rules).

import { net } from 'electron';
import type { ClientRequest, IncomingMessage, Session } from 'electron';
import { pickHeaders } from '@poe-upgrade-finder/trade';
import type { HttpOutcome, HttpRequest, HttpTransport } from '@poe-upgrade-finder/trade';

export function electronTransport(session: Session): HttpTransport {
    return {
        send(request: HttpRequest): Promise<HttpOutcome> {
            return new Promise<HttpOutcome>((resolve: (outcome: HttpOutcome) => void) => {
                let settled: boolean = false;
                const req: ClientRequest = net.request({
                    method: request.method,
                    url: request.url,
                    session: session,
                    useSessionCookies: true,
                    redirect: 'manual',
                });
                const finish = (outcome: HttpOutcome): void => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    request.signal?.removeEventListener('abort', onAbort);
                    resolve(outcome);
                };
                const onAbort = (): void => {
                    finish({ kind: 'aborted' });
                    req.abort();
                };
                const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
                    finish({ kind: 'timeout' });
                    req.abort();
                }, request.timeoutMs);
                if (request.signal?.aborted === true) {
                    onAbort();
                    return;
                }
                request.signal?.addEventListener('abort', onAbort, { once: true });
                for (const [name, value] of Object.entries(request.headers)) {
                    req.setHeader(name, value);
                }
                if (request.body !== undefined) {
                    req.setHeader('Content-Type', 'application/json');
                }
                req.on('response', (response: IncomingMessage) => {
                    const chunks: Buffer[] = [];
                    response.on('data', (chunk: Buffer) => {
                        chunks.push(chunk);
                    });
                    response.on('end', () => {
                        finish({
                            kind: 'response',
                            status: response.statusCode,
                            headers: pickHeaders(Object.entries(response.headers)),
                            text: Buffer.concat(chunks).toString('utf8'),
                        });
                    });
                    response.on('error', () => {
                        finish({ kind: 'network-error', message: 'response stream error' });
                    });
                });
                req.on('redirect', (statusCode: number, _method: string, redirectUrl: string) => {
                    finish({ kind: 'redirect', status: statusCode, location: redirectUrl });
                    req.abort();
                });
                req.on('error', (error: Error) => {
                    finish({ kind: 'network-error', message: error.message });
                });
                if (request.body !== undefined) {
                    req.write(request.body);
                }
                req.end();
            });
        },
    };
}
