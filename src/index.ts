import { Hono } from "hono";
import type { Env } from "./types";

export { TimerRoom } from "./timer-room";

const app = new Hono<{ Bindings: Env }>();

app.get("/ws", async (c) => {
  const upgradeHeader = c.req.header("upgrade");
  if (!upgradeHeader || upgradeHeader !== "websocket") {
    return c.text("Expected Upgrade: websocket", 426);
  }

  const id = c.env.TIMER_ROOM.idFromName("default-room");
  const stub = c.env.TIMER_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

export default app;
