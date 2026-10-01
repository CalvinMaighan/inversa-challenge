import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@emotion/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ShipsChipView } from "client/hud/ships/ShipsChip";
import { emotionTheme } from "client/themes/theme";
import { APP_IDS, getApp, hasLayer, LAYER_IDS } from "shared/apps";

const html = (el: ReactElement) => renderToStaticMarkup(<ThemeProvider theme={emotionTheme}>{el}</ThemeProvider>);
const noop = () => {};
const VESSELS = LAYER_IDS[9];

describe("ships chip", () => {
  test("ships chip: only carp and lionfish offer ships, so only they get the chip", () => {
    expect(APP_IDS.filter((id) => hasLayer(getApp(id), VESSELS)).sort()).toEqual(["carp", "lionfish"]);
  });

  test("ships chip: off, an icon button with a name and the word Ships to the right of the icon", () => {
    const markup = html(<ShipsChipView on={false} count={null} onToggle={noop} />);
    expect(markup).toContain('data-testid="ships-chip"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('aria-label="Ships: show ships on the map"');
    expect(markup.indexOf("<svg")).toBeLessThan(markup.indexOf("Ships</button>"));
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("<small");
  });

  test("ships chip: on, it says how many ships are drawn, like Python 5", () => {
    const markup = html(<ShipsChipView on count={6} onToggle={noop} />);
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("<small");
    expect(markup).toContain(">6<");
    expect(markup).toContain("Hide ships");
    // Before the layer has reported a count there is no number, only the state.
    expect(html(<ShipsChipView on count={null} onToggle={noop} />)).not.toContain("<small");
  });
});
