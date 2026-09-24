import { describe, expect, test } from "bun:test";

import { newSessionID, type ForgeOverview } from "@janela/core";
import { serializeForgeOverview } from "@janela/protocol";

import { createForgeOverviewStore, sessionLinkLookup } from "./forge-overview.ts";

const linked = newSessionID();

const overview: ForgeOverview = {
  repositories: [],
  sessions: [{ sessionID: linked, branch: "feat/inbox" }],
};

describe("forge overview store", () => {
  test("two refreshes while one is in flight are one request", async () => {
    const answer = Promise.withResolvers<string | undefined>();
    let asked = 0;
    const store = createForgeOverviewStore(
      {
        request: () => {
          asked += 1;

          return answer.promise;
        },
      },
      () => 7,
    );

    const first = store.refresh();
    const second = store.refresh();

    answer.resolve(serializeForgeOverview(overview));
    await Promise.all([first, second]);

    expect(asked).toBe(1);
    expect(store.state).toEqual({ kind: "loaded", overview, receivedAt: 7 });
    expect(sessionLinkLookup(store.state)(linked)?.branch).toBe("feat/inbox");
  });

  test("a failed refresh keeps the last overview on screen", async () => {
    const answers: (string | undefined)[] = [serializeForgeOverview(overview), undefined];
    const store = createForgeOverviewStore({
      request: () => Promise.resolve(answers.shift()),
    });

    await store.refresh();
    await store.refresh();

    expect(store.state.kind).toBe("loaded");
  });

  test("a first answer that never comes, or is not an overview, is unreachable", async () => {
    const refused = createForgeOverviewStore({
      request: () => Promise.reject(new Error("disconnected")),
    });

    const garbled = createForgeOverviewStore({ request: () => Promise.resolve("{}") });

    await refused.refresh();
    await garbled.refresh();

    expect(refused.state.kind).toBe("unreachable");
    expect(garbled.state.kind).toBe("unreachable");
  });
});
