import { Alert, AlertAction, AlertDescription, AlertTitle, Button, Spinner } from "@janela/design";
import { Match } from "effect";
import type { ReactElement } from "react";
import { useCallback } from "react";

import {
  type AppUpdateState,
  useClientEnvironment,
  useStoreValue,
} from "../../../shared/model/index.ts";
import { bannerModel } from "./connection-banner.tsx";

export type UpdateBannerAction = "install" | "relaunch";

export type UpdateBannerModel =
  | { readonly kind: "none" }
  | { readonly kind: "strip"; readonly text: string }
  | {
      readonly kind: "notice";
      readonly title: string;
      readonly description: string | undefined;
      readonly primary: { readonly label: string; readonly action: UpdateBannerAction } | undefined;
      readonly dismissLabel: string;
      readonly destructive: boolean;
    };

const NONE: UpdateBannerModel = { kind: "none" };

export function updateBannerModel(
  state: AppUpdateState,
  connectionBusy: boolean,
): UpdateBannerModel {
  if (connectionBusy) return NONE;

  return Match.value(state).pipe(
    Match.when({ kind: "idle" }, () => NONE),
    Match.when({ kind: "checking" }, ({ announced }) =>
      announced
        ? ({ kind: "strip", text: "Checking for updates…" } satisfies UpdateBannerModel)
        : NONE,
    ),
    Match.when(
      { kind: "upToDate" },
      () =>
        ({
          kind: "notice",
          title: "Janela is up to date.",
          description: undefined,
          primary: undefined,
          dismissLabel: "OK",
          destructive: false,
        }) satisfies UpdateBannerModel,
    ),
    Match.when(
      { kind: "available" },
      ({ version }) =>
        ({
          kind: "notice",
          title: `Janela ${version} is available.`,
          description: "Download and install it now. Your terminals keep running.",
          primary: { label: "Update", action: "install" },
          dismissLabel: "Later",
          destructive: false,
        }) satisfies UpdateBannerModel,
    ),
    Match.when(
      { kind: "downloading" },
      ({ version, fraction }) =>
        ({
          kind: "strip",
          text:
            fraction === undefined
              ? `Downloading Janela ${version}…`
              : `Downloading Janela ${version}… ${Math.round(fraction * 100)}%`,
        }) satisfies UpdateBannerModel,
    ),
    Match.when(
      { kind: "ready" },
      ({ version }) =>
        ({
          kind: "notice",
          title: `Janela ${version} is installed. Restart Janela to finish.`,
          description: "Your terminals keep running in the background service.",
          primary: { label: "Restart Now", action: "relaunch" },
          dismissLabel: "Later",
          destructive: false,
        }) satisfies UpdateBannerModel,
    ),
    Match.when(
      { kind: "failed" },
      ({ text }) =>
        ({
          kind: "notice",
          title: text,
          description: undefined,
          primary: undefined,
          dismissLabel: "Dismiss",
          destructive: true,
        }) satisfies UpdateBannerModel,
    ),
    Match.exhaustive,
  );
}

export function UpdateBanner(): ReactElement | null {
  const { connection, view, local } = useClientEnvironment();
  const status = useStoreValue(connection, () => connection.status);
  const state = useStoreValue(view, () => view.appUpdate);
  const updates = local?.updates;

  const install = useCallback(() => {
    void updates?.install();
  }, [updates]);

  const relaunch = useCallback(() => {
    void updates?.relaunch();
  }, [updates]);

  const dismiss = useCallback(() => {
    updates?.dismiss();
  }, [updates]);

  if (updates === undefined) return null;

  const model = updateBannerModel(state, bannerModel(status).kind !== "none");

  if (model.kind === "none") return null;

  if (model.kind === "strip") {
    return (
      <output
        aria-live="polite"
        className="border-border bg-muted text-muted-foreground absolute inset-x-0 top-0 flex items-center justify-center gap-2 border-b px-2 py-1 text-xs"
      >
        <Spinner aria-hidden="true" size={12} />
        {model.text}
      </output>
    );
  }

  const { primary } = model;

  return (
    <Alert
      variant={model.destructive ? "destructive" : "default"}
      className="absolute inset-x-0 top-0 z-10 rounded-none has-data-[slot=alert-action]:absolute has-data-[slot=alert-action]:pr-2.5"
    >
      <AlertTitle>{model.title}</AlertTitle>
      {model.description === undefined ? undefined : (
        <AlertDescription>{model.description}</AlertDescription>
      )}
      <AlertAction className="static mt-2">
        {primary === undefined ? undefined : (
          <Button
            variant="outline"
            size="sm"
            onClick={primary.action === "install" ? install : relaunch}
          >
            {primary.label}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={dismiss}>
          {model.dismissLabel}
        </Button>
      </AlertAction>
    </Alert>
  );
}
