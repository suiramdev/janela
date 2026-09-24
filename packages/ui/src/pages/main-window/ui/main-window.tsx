import { SidebarProvider, SizeProvider, TooltipProvider } from "@janela/design";
import { useCallback, useEffect, useMemo, type ReactElement } from "react";

import type { CommandID } from "../../../shared/config/index.ts";
import {
  draftSettings,
  type SettingsRoute,
  useClientEnvironment,
  useStoreValue,
} from "../../../shared/model/index.ts";
import { ContextMenuRegion, WINDOW_GUTTER_REGION, WindowColumn } from "../../../shared/ui/index.ts";
import { createCommandDispatch } from "../model/command-dispatch.ts";
import { windowMenuRows } from "../model/menu-rows.ts";
import { AppSidebar } from "./app-sidebar.tsx";
import { ConfirmationHost } from "./confirmation-host.tsx";
import { ConnectionBanner } from "./connection-banner.tsx";
import { ForgeOverviewProvider, usePolledForgeOverview } from "./forge-overview-context.tsx";
import { InboxView } from "./inbox-view.tsx";
import { SessionDetail } from "./session-detail.tsx";
import { SheetHost } from "./sheets/sheet-host.tsx";
import { UpdateBanner } from "./update-banner.tsx";
import { WelcomeScreen } from "./welcome.tsx";

export interface MainWindowProps {
  readonly renderSettings: (route: SettingsRoute) => ReactElement;
}

export function MainWindow(props: MainWindowProps): ReactElement {
  const environment = useClientEnvironment();
  const sessions = useStoreValue(environment.sessions, () => environment.sessions.sessions);
  const selection = useStoreValue(environment.sessions, () => environment.sessions.selection);

  const { view, commands, settings, local } = environment;
  const screen = useStoreValue(view, () => view.screen);
  const theme = useStoreValue(view, () => draftSettings(view.settingsDraft, view.settings).theme);
  const forge = usePolledForgeOverview();

  const dispatch = useMemo(
    () =>
      createCommandDispatch({
        projects: environment.projects,
        sessions: environment.sessions,
        connection: environment.connection,
        view,
        local: environment.local,
        directories: environment.directories,
        confirmations: environment.confirmations,
      }),
    [environment, view],
  );

  const run = useCallback(
    (id: CommandID) => {
      void dispatch(id).catch(swallowRequestFailure);
    },
    [dispatch],
  );

  useEffect(() => commands.subscribe(run), [commands, run]);

  useEffect(() => {
    void settings.load().then((loaded) => {
      view.setSettings(loaded);

      return undefined;
    }, swallowRequestFailure);
  }, [settings, view]);

  useEffect(() => {
    if (local === undefined) return;

    void local.appearance.apply(theme).catch(swallowRequestFailure);
  }, [local, theme]);

  const selected =
    selection !== undefined && sessions.some((session) => session.id === selection)
      ? selection
      : undefined;

  const windowRows = useMemo(() => windowMenuRows(run), [run]);

  return (
    <TooltipProvider delay={400}>
      <SizeProvider size="compact">
        <ForgeOverviewProvider store={forge}>
          <ContextMenuRegion label="Janela" rows={windowRows} className="contents">
            <SidebarProvider
              className="relative h-full min-h-0 overflow-hidden"
              data-tauri-drag-region={WINDOW_GUTTER_REGION}
            >
              {screen.kind === "settings" ? (
                props.renderSettings(screen.route)
              ) : (
                <>
                  <AppSidebar dispatch={run} />
                  <WindowColumn>
                    {screen.kind === "inbox" ? (
                      <InboxView />
                    ) : selected === undefined ? (
                      <WelcomeScreen dispatch={run} />
                    ) : (
                      <SessionDetail sessionID={selected} />
                    )}
                  </WindowColumn>
                </>
              )}
              <ConnectionBanner />
              <UpdateBanner />
              <SheetHost dispatch={run} />
              <ConfirmationHost />
            </SidebarProvider>
          </ContextMenuRegion>
        </ForgeOverviewProvider>
      </SizeProvider>
    </TooltipProvider>
  );
}

function swallowRequestFailure(): undefined {
  return undefined;
}
