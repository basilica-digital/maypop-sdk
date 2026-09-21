import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

import { maypop as defaultMaypop, type Maypop } from "./index.js";

type MaypopApp = Maypop["app"];
type MaypopUser = Maypop["user"];
type MaypopMode = Maypop["mode"];
type MaypopTheme = Maypop["theme"];
type MaypopKvEntry = Awaited<ReturnType<Maypop["kv"]["list"]>>[number];

const EMPTY_PERMISSIONS: readonly string[] = Object.freeze([]);

/** The host connection and identity state exposed to React components. */
export type MaypopSession =
  | {
      status: "connecting";
      error: null;
      app: null;
      user: null;
      mode: "read-only";
      permissions: readonly string[];
      signInRequired: false;
      theme: "dark";
    }
  | {
      status: "ready";
      error: null;
      app: NonNullable<MaypopApp>;
      user: NonNullable<MaypopUser>;
      mode: MaypopMode;
      permissions: readonly string[];
      signInRequired: boolean;
      theme: MaypopTheme;
    }
  | {
      status: "error";
      error: Error;
      app: MaypopApp;
      user: MaypopUser;
      mode: MaypopMode;
      permissions: readonly string[];
      signInRequired: boolean;
      theme: MaypopTheme;
    };

const CONNECTING_SESSION: MaypopSession = Object.freeze({
  status: "connecting",
  error: null,
  app: null,
  user: null,
  mode: "read-only",
  permissions: EMPTY_PERMISSIONS,
  signInRequired: false,
  theme: "dark",
});

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class SessionStore {
  private snapshot: MaypopSession = CONNECTING_SESSION;
  private readonly listeners = new Set<() => void>();
  private stop: (() => void) | null = null;
  private generation = 0;

  constructor(private readonly client: Maypop) {}

  readonly getSnapshot = (): MaypopSession => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop?.();
    };
  };

  private publish(snapshot: MaypopSession): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private start(): void {
    const generation = ++this.generation;
    const isCurrent = () => generation === this.generation;

    const sync = () => {
      if (!isCurrent() || !this.client.app || !this.client.user) return;
      this.publish({
        status: "ready",
        error: null,
        app: this.client.app,
        user: this.client.user,
        mode: this.client.mode,
        permissions: Object.freeze([...this.client.permissions]),
        signInRequired: this.client.signInRequired,
        theme: this.client.theme,
      });
    };

    const fail = (error: unknown) => {
      if (!isCurrent()) return;
      this.publish({
        status: "error",
        error: toError(error),
        app: this.client.app,
        user: this.client.user,
        mode: this.client.mode,
        permissions: Object.freeze([...this.client.permissions]),
        signInRequired: this.client.signInRequired,
        theme: this.client.theme,
      });
    };

    const unsubscribeMode = this.client.on("modechange", sync);
    const unsubscribeTheme = this.client.on("themechange", sync);
    const unsubscribeRevoked = this.client.on("revoked", () => {
      fail(new Error("The Maypop session was revoked."));
    });

    void this.client.ready().then(sync, fail);

    this.stop = () => {
      if (!isCurrent()) return;
      ++this.generation;
      unsubscribeMode();
      unsubscribeTheme();
      unsubscribeRevoked();
      this.stop = null;
    };
  }
}

type KvSnapshot = {
  status: "loading" | "ready" | "error";
  entry: MaypopKvEntry | null;
  error: Error | null;
  isMutating: boolean;
};

const LOADING_KV: KvSnapshot = {
  status: "loading",
  entry: null,
  error: null,
  isMutating: false,
};

class KvStore {
  private snapshot: KvSnapshot = LOADING_KV;
  private readonly listeners = new Set<() => void>();
  private stop: (() => void) | null = null;
  private generation = 0;
  private mutationCount = 0;

  constructor(
    private readonly client: Maypop,
    private readonly key: string,
  ) {}

  readonly getSnapshot = (): KvSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop?.();
    };
  };

  readonly setValue = async (value: unknown): Promise<void> => {
    await this.mutate(() => this.client.kv.set(this.key, value));
  };

  readonly deleteValue = async (): Promise<void> => {
    await this.mutate(() => this.client.kv.delete(this.key));
  };

  private publish(snapshot: KvSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private start(): void {
    const generation = ++this.generation;
    let unsubscribe: (() => void) | null = null;
    const isCurrent = () => generation === this.generation;

    void this.client.ready().then(
      () => {
        if (!isCurrent()) return;
        unsubscribe = this.client.kv.subscribe(this.key, (entries) => {
          if (!isCurrent()) return;
          this.publish({
            status: "ready",
            entry: entries.find((entry) => entry.key === this.key) ?? null,
            error: null,
            isMutating: this.mutationCount > 0,
          });
        });
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        this.publish({
          ...this.snapshot,
          status: "error",
          error: toError(error),
        });
      },
    );

    this.stop = () => {
      if (!isCurrent()) return;
      ++this.generation;
      unsubscribe?.();
      this.stop = null;
    };
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    ++this.mutationCount;
    this.publish({
      ...this.snapshot,
      error: null,
      isMutating: true,
    });

    try {
      await this.client.ready();
      await operation();
    } catch (error) {
      this.publish({ ...this.snapshot, error: toError(error) });
      throw error;
    } finally {
      --this.mutationCount;
      this.publish({
        ...this.snapshot,
        isMutating: this.mutationCount > 0,
      });
    }
  }
}

type ReactSdkContext = {
  client: Maypop;
  session: SessionStore;
  kv: Map<string, KvStore>;
};

function createReactSdkContext(client: Maypop): ReactSdkContext {
  return {
    client,
    session: new SessionStore(client),
    kv: new Map(),
  };
}

const defaultContext = createReactSdkContext(defaultMaypop);
const MaypopContext = createContext(defaultContext);

/** Props for {@link MaypopProvider}. */
export interface MaypopProviderProps {
  children: ReactNode;
  /** Override the browser SDK, primarily for tests and local sandbox hosts. */
  client?: Maypop;
}

/** Provide a specific SDK client to descendant hooks. Optional in hosted apps. */
export function MaypopProvider({
  children,
  client = defaultMaypop,
}: MaypopProviderProps): ReactElement {
  const context = useMemo(() => createReactSdkContext(client), [client]);
  return createElement(MaypopContext.Provider, { value: context }, children);
}

/** Return the SDK client used by the nearest provider. */
export function useMaypop(): Maypop {
  return useContext(MaypopContext).client;
}

/** Subscribe to host readiness, identity, permissions, mode, and theme. */
export function useMaypopSession(): MaypopSession {
  const store = useContext(MaypopContext).session;
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

/** Return the connected viewer, or null while the host is connecting. */
export function useMaypopViewer(): MaypopUser {
  return useMaypopSession().user;
}

/** Return the current app, or null while the host is connecting. */
export function useMaypopApp(): MaypopApp {
  return useMaypopSession().app;
}

/** Subscribe to the viewer's current read/write mode. */
export function useMaypopMode(): MaypopMode {
  return useMaypopSession().mode;
}

/** Subscribe to the host's current color theme. */
export function useMaypopTheme(): MaypopTheme {
  return useMaypopSession().theme;
}

/** A live value and mutation state for one key in the app's shared KV store. */
export interface MaypopKvValue<T> {
  value: T;
  entry: MaypopKvEntry | null;
  status: "loading" | "ready" | "error";
  error: Error | null;
  isMutating: boolean;
  setValue(value: T): Promise<void>;
  deleteValue(): Promise<void>;
}

/** Subscribe to one shared KV key and expose stable write/delete functions. */
export function useMaypopKV<T>(key: string, fallback: T): MaypopKvValue<T> {
  const context = useContext(MaypopContext);
  let store = context.kv.get(key);
  if (!store) {
    store = new KvStore(context.client, key);
    context.kv.set(key, store);
  }

  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  return useMemo(
    () => ({
      value: snapshot.entry ? (snapshot.entry.value as T) : fallback,
      entry: snapshot.entry,
      status: snapshot.status,
      error: snapshot.error,
      isMutating: snapshot.isMutating,
      setValue: store.setValue as (value: T) => Promise<void>,
      deleteValue: store.deleteValue,
    }),
    [fallback, snapshot, store],
  );
}
