import { app } from "@azure/functions";
import { sessionHandler } from "./session.js";

app.http("private-session", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "private/session",
  handler: sessionHandler
});
