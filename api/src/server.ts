import "dotenv/config";
import { createApp } from "./app";
import { createContainer } from "./container";

const port = Number(process.env.PORT ?? 3000);
const app = createApp(createContainer());

app.listen(port, () => {
  console.log(`callisto-crm api listening on http://localhost:${port}`);
});
