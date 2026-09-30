"use client";

import type { JSX } from "react";
import isPropValid from "@emotion/is-prop-valid";
import styledBase, { type CreateStyled } from "@emotion/styled";

export { css, Global, keyframes, useTheme } from "@emotion/react";

/** `$`-prefixed props stay off the DOM, same convention as big-value and deedee. */
const shouldForwardProp = (prop: string) => isPropValid(prop) && !prop.startsWith("$");

const handler: ProxyHandler<CreateStyled> = {
  get: (_t, tag: keyof JSX.IntrinsicElements) => styledBase(tag, { shouldForwardProp }),
  apply: (_t, _this, [tag, options]) => styledBase(tag, { shouldForwardProp, ...options }),
};

const styled = new Proxy(styledBase, handler) as CreateStyled;
export default styled;
