import type { PluginCollapsibleOptions } from "expressive-code-collapsible";
import type { pluginLanguageLogo } from "ec-lang-logo";
import type { BundledTheme } from "shiki";

type LanguageLogoPluginOptions = NonNullable<Parameters<typeof pluginLanguageLogo>[0]>;

export interface ExpressiveCodeConfig {
  darkTheme: BundledTheme;
  lightTheme: BundledTheme;
  styleOverrides: {
    borderRadius?: string;
    codeFontFamily?: string;
    frames: {
      frameBoxShadowCssValue: string;
      editorTabBorderRadius?: string;
    };
  };
  pluginCollapsible: PluginCollapsibleOptions & {
    enable: boolean;
  };
  pluginLanguageLogo: LanguageLogoPluginOptions & {
    enable: boolean;
  };
  pluginLineNumbers: {
    enable: boolean;
  };
}
