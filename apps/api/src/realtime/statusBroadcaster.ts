import type { Response } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { fetchFeedStatus, type FeedStatusSnapshot } from '../db/feedStatus.js';

// The "radio frequency". Must match STATUS_CHANNEL in apps/simulator/publisher.py.
export const STATUS_CHANNEL = 'nimbus:feed-status';

// If no nudge has arrived for this long, send a snapshot anyway. Silence is
// ambiguous ("nothing new" vs "the simulator died"); a regular snapshot lets
// the stale flags from SQL show up, and keeps idle connections from being
// closed by proxies.
const HEARTBEAT_MS = 5_000;

/** Why an event was sent. The browser uses this to tell "live" from "only heartbeats". */
export type StatusTrigger = 'snapshot' | 'tick' | 'heartbeat';

/** What each SSE "status" event carries: the reason, plus the data itself. */
export type StatusEvent = { trigger: StatusTrigger; snapshot: FeedStatusSnapshot };

/**
 * Pushes live feed status to every connected browser using Server-Sent Events.
 *
 *   simulator ──PUBLISH──► Redis ──message──► this class ──SSE──► browsers
 *
 * One instance per API process. It listens on Redis, and when a nudge
 * arrives it reads the latest status ONCE and writes it to ALL its clients,
 * so 100 open browser tabs cost one database query per tick, not 100.
 */
export class StatusBroadcaster {
  private readonly clients = new Set<Response>();
  private heartbeat: NodeJS.Timeout | undefined;
  private lastSentAt = 0;

  constructor(
    private readonly pool: pg.Pool,
    // A Redis connection in subscriber mode can ONLY listen; it can't run
    // other commands. So this is a second, dedicated connection.
    private readonly subscriber: Redis,
  ) {}

  /**
   * Start listening for nudges and sending heartbeats. The returned promise
   * resolves once the subscription is active. If Redis is down, ioredis
   * keeps retrying and subscribes as soon as it's back.
   */
  async start(): Promise<void> {
    this.subscriber.on('message', () => void this.broadcast('tick'));

    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSentAt >= HEARTBEAT_MS) void this.broadcast('heartbeat');
    }, 1_000);

    await this.subscriber.subscribe(STATUS_CHANNEL);
  }

  /** Turn an HTTP response into a live stream and keep it until it closes. */
  async addClient(res: Response): Promise<void> {
    // Read the snapshot BEFORE committing to a stream: if the database is
    // down, this throws and Express sends a normal JSON 500 instead.
    const snapshot = await fetchFeedStatus(this.pool);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream', // "this response is an SSE stream"
      'Cache-Control': 'no-cache', // never cache a live stream
      Connection: 'keep-alive',
    });

    // Snapshot first, then live updates: a newly connected (or reconnected)
    // browser is immediately up to date, no matter what it missed.
    res.write('retry: 3000\n\n'); // tells the browser: reconnect after 3s if dropped
    res.write(toEvent({ trigger: 'snapshot', snapshot }));

    // First listener after a quiet spell: it just got a snapshot, so don't
    // let the heartbeat send an identical one a moment later.
    if (this.clients.size === 0) this.lastSentAt = Date.now();
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res)); // tab closed / network gone
  }

  /** How many browsers are connected right now (handy for tests and logs). */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Read the latest status once and send it to every client. */
  private async broadcast(trigger: StatusTrigger): Promise<void> {
    if (this.clients.size === 0) return; // nobody listening: skip the query
    this.lastSentAt = Date.now();
    try {
      const snapshot = await fetchFeedStatus(this.pool);
      const event = toEvent({ trigger, snapshot });
      for (const res of this.clients) res.write(event);
    } catch (err) {
      // Keep the streams open; the next nudge or heartbeat will try again.
      console.error('Status broadcast failed:', (err as Error).message);
    }
  }

  /** Graceful shutdown: end every stream and stop listening. */
  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
    await this.subscriber.quit();
  }
}

/**
 * The SSE wire format is plain text: an optional "event:" name, a "data:"
 * line, and a blank line that marks the end of the message.
 *
 *   event: status
 *   data: {"trigger":"tick","snapshot":{...}}
 *
 */
function toEvent(event: unknown): string {
  return `event: status\ndata: ${JSON.stringify(event)}\n\n`;
}
