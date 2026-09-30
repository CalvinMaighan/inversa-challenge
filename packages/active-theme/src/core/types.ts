export type ThemeMode = "light" | "dark";

export type ThemeColorPalette = {
  hue: number;
  chromaBase?: number;
  swatchChroma?: number;
  swatchLightness?: number;
};

export type ThemeDefinition<C extends string = string> = {
  readonly modes: readonly ThemeMode[];
  readonly defaultMode: ThemeMode;
  readonly defaultColor: C;
  readonly colors: Record<C, ThemeColorPalette>;
  readonly persist: boolean;
  readonly shared: boolean;
  /** localStorage prefix for mode/color when persist is on. */
  readonly storagePrefix: string;
};

export type DefineThemeInput<C extends string = string> = {
  modes?: readonly ThemeMode[];
  defaultMode?: ThemeMode;
  /** Infer `C` from `colors` keys only, so the default must be one of them. */
  defaultColor: NoInfer<C>;
  colors: Record<C, ThemeColorPalette>;
  /** Default true — remember mode/color in localStorage. */
  persist?: boolean;
  /** Default true when persist — sync other tabs via `storage`. */
  shared?: boolean;
  storagePrefix?: string;
};
