import "i18next";
import type { Translations } from "./types";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: Translations;
  }
}
