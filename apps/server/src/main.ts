import { buildTeamServerApp } from "./app.js";
import { teamServerConfigFromEnv } from "./config.js";

const config = teamServerConfigFromEnv();
const { app } = buildTeamServerApp(config);

app
  .listen({ host: config.host, port: config.port })
  .then((address) => {
    console.log(`queuepilot team server listening on ${address}`);
    console.log(`db: ${config.dbPath}`);
    if (!config.adminToken) {
      console.log(
        "note: QUEUEPILOT_TEAM_ADMIN_TOKEN is unset — token minting needs a minted admin token in the DB (chicken-and-egg on first boot). Set it to bootstrap.",
      );
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
