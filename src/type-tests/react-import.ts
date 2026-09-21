import {
  MaypopProvider,
  useMaypop,
  useMaypopApp,
  useMaypopKV,
  useMaypopMode,
  useMaypopSession,
  useMaypopTheme,
  useMaypopViewer,
  type MaypopKvValue,
  type MaypopProviderProps,
  type MaypopSession,
} from "../react.js";

const session: MaypopSession = useMaypopSession();
const count: MaypopKvValue<number> = useMaypopKV("count", 0);
const provider: (props: MaypopProviderProps) => React.ReactElement =
  MaypopProvider;

void [
  session,
  count,
  provider,
  useMaypop,
  useMaypopApp,
  useMaypopMode,
  useMaypopTheme,
  useMaypopViewer,
];
