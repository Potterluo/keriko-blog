import { siteConfig } from "@/config/siteConfig";
import { enUS } from "@/i18n/languages/en-US";
import { zhCN } from "@/i18n/languages/zh-CN";
import type { I18nKey } from "@/i18n/i18nKey";
import type { Locale, Translation, TranslationParams, Translator } from "@/types/i18n";

const translations = {
  "en-US": enUS,
  "zh-CN": zhCN,
} as const satisfies Record<Locale, Translation>;

export function getTranslation(locale: Locale = siteConfig.lang): Translation {
  return translations[locale];
}

function interpolate(message: string, params?: TranslationParams): string {
  if (!params) {
    return message;
  }

  return message.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
    const value = params[key];
    return value === undefined ? placeholder : String(value);
  });
}

export function getTranslator(locale: Locale = siteConfig.lang): Translator {
  const translation = getTranslation(locale);
  return (key, params) => interpolate(translation[key], params);
}

export function i18n(key: I18nKey, params?: TranslationParams): string {
  return interpolate(getTranslation()[key], params);
}
