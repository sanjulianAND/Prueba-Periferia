import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";

const config = loadConfig();
const app = createApp({ config });

app.listen(config.PORT, () => {
  console.log(`API disponible en http://localhost:${config.PORT}`);
});
