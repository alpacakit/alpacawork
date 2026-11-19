/** A byte-only bridge from jsdom FileReader to real Node HTTP, with XHR's distinct failure boundaries. */
import { request, type ClientRequest } from 'node:http';

export type XhrFault = { phase: 'read' | 'transport' | 'callback'; method: string; path: string; cause: unknown };
export function httpXHR(origin: string, options: {
  hold: () => Promise<void>;
  sent: (path: string) => void;
  loaded: (path: string) => void;
  fault: (fault: XhrFault) => void;
}) {
  return class HttpXHR {
    upload = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0; responseText = ''; path = ''; method = '';
    private headers: Record<string, string> = {};
    private outgoing?: ClientRequest;
    private aborted = false;
    open(method: string, path: string) { this.method = method; this.path = path; }
    setRequestHeader(name: string, value: string) { this.headers[name] = value; }
    abort() { if (this.aborted) return; this.aborted = true; this.outgoing?.destroy(); this.onabort?.(); }
    send(file: File) {
      const held = options.hold(); options.sent(this.path);
      const fail = (phase: XhrFault['phase'], cause: unknown) => {
        options.fault({ phase, method: this.method, path: this.path, cause });
        // A caller throwing while handling a delivered reply is not a transport failure.
        if (phase !== 'callback') this.onerror?.();
      };
      const reader = new FileReader();
      reader.onerror = () => fail('read', reader.error);
      reader.onload = () => {
        void held.then(() => {
          if (this.aborted) return;
          const bytes = Buffer.from(new Uint8Array(reader.result as ArrayBuffer));
          // A new connection each time: a browser sends again when a reused one turns out closed, and Node's client would report it as a failed upload.
          this.outgoing = request(new URL(this.path, origin), { method: this.method, headers: this.headers, agent: false }, response => {
            this.status = response.statusCode!;
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.once('error', cause => { if (!this.aborted) fail('transport', cause); });
            response.once('end', () => {
              this.responseText = Buffer.concat(chunks).toString('utf8');
              try { this.onload?.(); } catch (cause) { fail('callback', cause); }
              finally { options.loaded(this.path); }
            });
          });
          this.outgoing.once('error', cause => { if (!this.aborted) fail('transport', cause); });
          this.outgoing.end(bytes);
        }).catch(cause => fail('read', cause));
      };
      reader.readAsArrayBuffer(file);
    }
  };
}
