import protobuf from "protobufjs";
import { join } from "node:path";
import type { FeedTick, TrainUpdate } from "../../src/lib/types";
import { makeDecoder, type Decoder } from "../../src/lib/feed";

export { FEEDS, fetchFeed, FEED_BASE as BASE } from "../../src/lib/feed";
export type { Decoder };

export async function loadDecoder(): Promise<Decoder> {
  const root = await protobuf.load(join(import.meta.dirname, "proto", "nyct-subway.proto"));
  return makeDecoder(root.lookupType("transit_realtime.FeedMessage"));
}

export function makeTick(feed: string, fetchedAt: number, decoded: { ts: number; trains: TrainUpdate[] }): FeedTick {
  return { feed, ts: decoded.ts, fetchedAt, trains: decoded.trains };
}
