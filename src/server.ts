import { createServer } from "node:http";
import { createHandler, loadConfig } from "./gateway.ts";

const port = Number(process.env.PORT ?? 8080);
const server = createServer(createHandler(loadConfig()));
server.listen(port, "0.0.0.0", () => console.log(`responses gateway listening on :${port}`));

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
