import { createStore } from "./store.js";
import { createTicketService } from "./tickets.js";
import { createApp } from "./http.js";
import { systemClock } from "./clock.js";

const service = createTicketService({ store: createStore(), clock: systemClock });
const port = Number(process.env.PORT ?? 3000);
createApp({ service }).listen(port, () => console.log(`listening on http://localhost:${port}`));
