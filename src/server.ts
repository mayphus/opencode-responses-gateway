import { createServer } from "node:http";
import { createHandler, loadConfig } from "./gateway.ts";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const server = createServer(createHandler(loadConfig()));
server.listen(port, host, () => console.log(`responses gateway listening on http://${host}:${port}`));

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
