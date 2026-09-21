import maypop, {
  getMaypop,
  maypop as namedMaypop,
  type Maypop,
} from "../index.js";

const defaultSdk: Maypop = maypop;
const namedSdk: Maypop = namedMaypop;
const deferredSdk: Maypop = getMaypop();

void [defaultSdk, namedSdk, deferredSdk];
