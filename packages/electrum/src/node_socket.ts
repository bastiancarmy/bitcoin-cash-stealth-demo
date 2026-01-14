// packages/electrum/src/node_socket.ts
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'eventemitter3';
import type { ElectrumSocket, ElectrumSocketEvents } from '@electrum-cash/network';

export type NodeElectrumSocketOptions = {
  host: string;
  port: number;
  encrypted: boolean;
  timeout: number;
  tlsOptions?: tls.ConnectionOptions;
};

export class NodeElectrumSocket
  extends EventEmitter<ElectrumSocketEvents>
  implements ElectrumSocket
{
  public host: string;
  public port: number;
  public encrypted: boolean;
  public timeout: number;

  // These “tuple fields” are part of the ElectrumSocket interface typing contract.
  // (Same pattern as @electrum-cash/web-socket)
  public readonly connected!: [];
  public readonly disconnected!: [];
  public readonly data!: [string];
  public readonly error!: [Error];

  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = '';
  private tlsOptions?: tls.ConnectionOptions;

  public constructor(opts: NodeElectrumSocketOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port;
    this.encrypted = opts.encrypted;
    this.timeout = opts.timeout;
    this.tlsOptions = opts.tlsOptions;
  }

  public get hostIdentifier(): string {
    return `${this.host}:${this.port}${this.encrypted ? ' (tls)' : ''}`;
  }

  public connect(): void {
    if (this.socket) return;

    const onConnect = () => this.emit('connected');
    const onClose = () => {
      this.cleanup();
      this.emit('disconnected');
    };
    const onError = (err: Error) => {
      this.emit('error', err);
      this.disconnect();
    };

    const onData = (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      while (true) {
        const idx = this.buffer.indexOf('\n');
        if (idx === -1) break;

        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);

        const trimmed = line.trim();
        if (trimmed.length > 0) this.emit('data', trimmed);
      }
    };

    if (this.encrypted) {
      const s = tls.connect(
        {
          host: this.host,
          port: this.port,
          servername: this.host,
          timeout: this.timeout,
          ...this.tlsOptions
        },
        onConnect
      );

      s.on('data', onData);
      s.on('close', onClose);
      s.on('end', onClose);
      s.on('error', onError);
      s.setTimeout(this.timeout, () => onError(new Error('Socket timeout')));

      this.socket = s;
      return;
    }

    const s = net.connect(
      {
        host: this.host,
        port: this.port,
        timeout: this.timeout
      },
      onConnect
    );

    s.on('data', onData);
    s.on('close', onClose);
    s.on('end', onClose);
    s.on('error', onError);
    s.setTimeout(this.timeout, () => onError(new Error('Socket timeout')));

    this.socket = s;
  }

  public disconnect(): void {
    if (!this.socket) return;

    const s = this.socket;
    this.socket = null;

    try { s.end(); } catch {}
    try { s.destroy(); } catch {}

    this.cleanup();
    this.emit('disconnected');
  }

  public write(data: string | Uint8Array, callback?: (err?: Error) => void): boolean {
    if (!this.socket) {
      callback?.(new Error('Socket not connected'));
      return false;
    }

    const out =
      typeof data === 'string'
        ? Buffer.from(data.endsWith('\n') ? data : `${data}\n`, 'utf8')
        : Buffer.concat([Buffer.from(data), Buffer.from('\n', 'utf8')]);

    try {
      return this.socket.write(out, (err?: Error | null) => callback?.(err ?? undefined));
    } catch (e) {
      callback?.(e instanceof Error ? e : new Error(String(e)));
      return false;
    }
  }

  private cleanup(): void {
    this.buffer = '';
  }
}