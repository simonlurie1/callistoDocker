import "dotenv/config";
import { createApp } from "./app";
import { createContainer } from "./container";
import { logger, setServiceName } from "./lib/logger";

setServiceName("api");
const port = Number(process.env.PORT ?? 3000);
const app = createApp(createContainer());

app.listen(port, () => {
  logger.info(`callisto-crm api listening on http://localhost:${port}`);
});
