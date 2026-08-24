type RegisteredCommand = {
  namespace: string;
  name: string;
  title: string;
  desc: string;
  category: string;
  slashName: string;
  run: () => void | Promise<void>;
};

type RegisteredLayer = {
  commands: readonly RegisteredCommand[];
  bindings: readonly unknown[];
};

interface HostTuiApi {
  readonly state: { readonly path: { readonly directory: string } };
  readonly keymap: { readonly registerLayer: (input: RegisteredLayer) => unknown };
  readonly route: { readonly current: { readonly name: string; readonly params?: Record<string, unknown> } };
  readonly client: { readonly session: { readonly promptAsync: (input: unknown) => Promise<void> } };
  readonly ui: { readonly toast: (input: unknown) => void; readonly dialog: { readonly setSize: (input: unknown) => void; readonly replace: (input: unknown) => void } };
  readonly theme: { readonly current: { readonly text: string; readonly textMuted: string; readonly success: string; readonly warning: string; readonly error: string; readonly accent: string; readonly border: string } };
}

export function createApi(routeName = "session") {
  const prompts: unknown[] = [];
  const toasts: unknown[] = [];
  const dialogSetSizes: unknown[] = [];
  const dialogReplacements: unknown[] = [];
  let layer: RegisteredLayer | undefined;
  const api: HostTuiApi = {
    keymap: {
      registerLayer(input: RegisteredLayer) {
        layer = input;
        return () => {};
      },
    },
    route: {
      current: routeName === "session" ? { name: "session", params: { sessionID: "ses_tui" } } : { name: "home" },
    },
    state: { path: { directory: "/repo" } },
    client: {
      session: {
        async promptAsync(input: unknown) {
          prompts.push(input);
        },
      },
    },
    ui: {
      toast(input: unknown) {
        toasts.push(input);
      },
      dialog: {
        setSize(input: unknown) {
          dialogSetSizes.push(input);
        },
        replace(input: unknown) {
          dialogReplacements.push(input);
        },
      },
    },
    theme: {
      current: {
        text: "text",
        textMuted: "muted",
        success: "success",
        warning: "warning",
        error: "error",
        accent: "accent",
        border: "border",
      },
    },
  };
  return { api, prompts, toasts, dialogSetSizes, dialogReplacements, get layer() { return layer; } };
}
