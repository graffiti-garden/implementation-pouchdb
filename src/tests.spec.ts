import {
  graffitiLocationTests,
  graffitiCRUDTests,
  graffitiSynchronizeTests,
  graffitiDiscoverTests,
} from "@graffiti-garden/api/tests";
import { GraffitiLocal } from "./index";

const useGraffiti = () => new GraffitiLocal();
const useSession1 = () => ({ actor: "someone" });
const useSession2 = () => ({ actor: "someoneelse" });

graffitiLocationTests(useGraffiti);
graffitiCRUDTests(useGraffiti, useSession1, useSession2);
graffitiSynchronizeTests(useGraffiti, useSession1, useSession2);
graffitiDiscoverTests(useGraffiti, useSession1, useSession2);
