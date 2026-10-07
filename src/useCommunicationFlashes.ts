import { useCallback, useEffect, useRef, useState } from "react";
import { eventAge, listOutbox, onDaemonEvent, type DaemonEvent, type Seat } from "./api";

/** How long a connection stays highlighted. */
export const FLASH_MS = 2500;
const OUTBOX_POLL_MS = 2000;
/** Events older than this are replayed history, not live traffic. */
const LIVE_EVENT_MAX_AGE_MS = 15000;

/** A highlighted connection between two seats, by logical id. */
export interface Flash {
  from: string;
  to: string;
}

/** The sender and recipient sessions of an event that means "one seat talked to another". */
function communicationIn(event: DaemonEvent): [string, string] | null {
  switch (event.type) {
    case "queue.created":
      return [event.sourceSession as string, event.destinationSession as string];
    case "queue.handed_off":
      return [event.fromSession as string, event.toSession as string];
    default:
      return null;
  }
}

/**
 * Seats that just communicated. Two sources:
 * - `rig send` between seats, from each seat's outbox (polled; the daemon
 *   records a seat's sends but emits no event for them).
 * - queue items created or handed off, from the daemon's event stream.
 */
export function useCommunicationFlashes(seats: Seat[]): Flash[] {
  const [flashes, setFlashes] = useState<Flash[]>([]);
  const sessionToLogical = useRef(new Map<string, string>());
  sessionToLogical.current = new Map(seats.map((s) => [s.canonicalSessionName, s.logicalId]));

  const flash = useCallback((fromSession: string, toSession: string) => {
    const from = sessionToLogical.current.get(fromSession);
    const to = sessionToLogical.current.get(toSession);
    if (!from || !to || from === to) return;
    const entry: Flash = { from, to };
    // A repeat of the same pair restarts its timer rather than stacking.
    setFlashes((current) => [...current.filter((f) => f.from !== from || f.to !== to), entry]);
    setTimeout(() => setFlashes((current) => current.filter((f) => f !== entry)), FLASH_MS);
  }, []);

  useEffect(
    () =>
      onDaemonEvent((event) => {
        const pair = communicationIn(event);
        if (pair && eventAge(event) < LIVE_EVENT_MAX_AGE_MS) flash(pair[0], pair[1]);
      }),
    [flash],
  );

  // Outbox ids already seen, per sender. A sender's first poll only records
  // what is already there, so old messages never flash.
  const seen = useRef(new Map<string, Set<string>>());
  const sessionsKey = seats.map((s) => s.canonicalSessionName).sort().join(",");

  useEffect(() => {
    const sessions = sessionsKey ? sessionsKey.split(",") : [];
    let cancelled = false;
    const poll = async () => {
      await Promise.all(
        sessions.map(async (session) => {
          let entries;
          try {
            entries = await listOutbox(session);
          } catch {
            return;
          }
          if (cancelled) return;
          const known = seen.current.get(session);
          if (!known) {
            seen.current.set(session, new Set(entries.map((e) => e.outboxId)));
            return;
          }
          for (const entry of entries) {
            if (known.has(entry.outboxId)) continue;
            known.add(entry.outboxId);
            flash(entry.senderSession, entry.destinationSession);
          }
        }),
      );
    };
    poll();
    const timer = setInterval(poll, OUTBOX_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionsKey, flash]);

  return flashes;
}
